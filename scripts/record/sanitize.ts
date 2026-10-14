/**
 * Sanitizer for recorded SDK streams (WP-01).
 *
 * Replaces personal data with stable placeholders before a fixture is written to
 * test/fixtures/sdk/. Session/message UUIDs stay untouched; everything that identifies the
 * machine owner (home/user/scratch paths, e-mail, org, account ids, host name) or looks like a
 * credential is replaced. Paths are matched in every spelling the CLI produces: backslashes,
 * JSON-escaped backslashes, forward slashes, `file:///` URLs, `%5C` and the project-directory
 * encoding of ~/.claude/projects (`C--Users-name-…`), with any drive-letter case.
 */

export const PLACEHOLDERS = {
  scratch: '<SCRATCH>',
  home: '<HOME>',
  user: '<USER>',
  host: '<HOST>',
  email: '<EMAIL>',
  org: '<ORG>',
  orgId: '<ORG_ID>',
  accountId: '<ACCOUNT_ID>',
  token: '<TOKEN>',
  signature: '<SIGNATURE>',
  redacted: '<REDACTED>',
} as const;

export interface SanitizeSecrets {
  /** Home directory, e.g. `C:\Users\name`. */
  home?: string;
  /** os.tmpdir(); scratch roots are `<tmpDir>\parallax-spike-YYYYMMDD-HHMMSS`. */
  tmpDir?: string;
  /** OS user name (replaced as a whole word, case-insensitive; ignored when shorter than 3). */
  username?: string;
  /** Machine name (ignored when shorter than 4). */
  hostname?: string;
  emails?: readonly string[];
  orgNames?: readonly string[];
  /** Organization/account UUIDs and other ids that must not appear in fixtures. */
  ids?: readonly string[];
}

/** E-mail addresses that are not personal and may stay. */
const EMAIL_ALLOWLIST: ReadonlySet<string> = new Set(['noreply@anthropic.com', 'git@github.com']);

const SCRATCH_DIR_NAME = String.raw`parallax-spike-\d{8}-\d{6}`;

/** One separator in any spelling: `\`, `\\`, `/`, `%5C`, or `-` (project-dir encoding). */
const SEP = String.raw`(?:\\+|/+|%5[Cc]|-)`;

const TOKEN_PATTERNS: readonly RegExp[] = [
  // Anthropic API keys (written as sk-an[t] so a repo-wide grep for the prefix stays clean).
  /sk-an[t]-[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g,
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** String-valued keys whose value is always replaced (matched case-insensitively). */
const SENSITIVE_KEYS: readonly { pattern: RegExp; placeholder: string }[] = [
  { pattern: /^(?:e-?mail|email_?address|user_?email)$/i, placeholder: PLACEHOLDERS.email },
  { pattern: /^(?:org|organization)_?(?:name)?$/i, placeholder: PLACEHOLDERS.org },
  { pattern: /^(?:org|organization)_?(?:id|uuid)$/i, placeholder: PLACEHOLDERS.orgId },
  { pattern: /^(?:account|user)_?(?:id|uuid)$/i, placeholder: PLACEHOLDERS.accountId },
  // Not displayName/fullName: ModelInfo.displayName ("Haiku") would become a "secret".
  { pattern: /^(?:user|account)_?name$/i, placeholder: PLACEHOLDERS.user },
  {
    pattern:
      /^(?:api_?key|token|secret|password|cookie|authorization|(?:access|refresh|auth|oauth|id|session|bearer)_?token)$/i,
    placeholder: PLACEHOLDERS.token,
  },
  { pattern: /^(?:signature|encrypted_?content)$/i, placeholder: PLACEHOLDERS.signature },
];

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source for one path segment: letters/digits literal, every other char may be encoded as any non-alnum. */
function segmentSource(segment: string): string {
  let out = '';
  for (const ch of segment) {
    out += /[A-Za-z0-9]/.test(ch) ? escapeRegex(ch) : '[^A-Za-z0-9]';
  }
  return out;
}

/** Regex source matching an absolute Windows (or POSIX) path in all spellings listed in the module doc. */
export function pathPatternSource(absPath: string): string {
  const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(absPath);
  const rest = drive ? (drive[2] ?? '') : absPath.replace(/^[\\/]+/, '');
  const segments = rest
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
    .map(segmentSource);
  const head = drive ? `${escapeRegex(drive[1] ?? '')}(?::|-)${SEP}` : SEP;
  return `${head}${segments.join(SEP)}`;
}

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(word)}(?![A-Za-z0-9])`, 'gi');
}

interface Rule {
  pattern: RegExp;
  replacement: string;
}

export interface Sanitizer {
  /** Sanitizes one string. */
  text(input: string): string;
  /** Deep-sanitizes a JSON-compatible value (keys and values). */
  value(input: unknown): unknown;
  /** Learns additional secret values (e.g. from accountInfo()) for subsequent calls. */
  learn(input: unknown): void;
  /** Returns descriptions of personal data still present in `text` (empty = clean). */
  findLeaks(text: string): string[];
}

/** Generic leak patterns that never need machine-specific knowledge. */
export function findGenericLeaks(text: string): string[] {
  const leaks: string[] = [];
  const userPath = /[A-Za-z](?::|-)(?:\\+|\/+|-)Users(?:\\+|\/+|-)(?!<)([A-Za-z0-9._-]+)/g;
  for (const match of text.matchAll(userPath)) {
    const name = match[1] ?? '';
    if (!['Public', 'Default', 'All'].includes(name)) leaks.push(`user path: ${match[0]}`);
  }
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    if (!EMAIL_ALLOWLIST.has(match[0].toLowerCase())) leaks.push(`e-mail: ${match[0]}`);
  }
  for (const pattern of TOKEN_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      leaks.push(`token-like: ${match[0].slice(0, 12)}…`);
    }
  }
  return leaks;
}

export function createSanitizer(secrets: SanitizeSecrets): Sanitizer {
  const learned = new Map<string, string>();

  function addSecret(value: string, placeholder: string): void {
    const trimmed = value.trim();
    if (trimmed.length < 4 || trimmed.startsWith('<')) return;
    if (!learned.has(trimmed)) learned.set(trimmed, placeholder);
  }

  for (const org of secrets.orgNames ?? []) addSecret(org, PLACEHOLDERS.org);
  for (const email of secrets.emails ?? []) {
    addSecret(email, PLACEHOLDERS.email);
    const local = email.split('@')[0] ?? '';
    if (local.length >= 4) addSecret(local, PLACEHOLDERS.user);
  }
  for (const id of secrets.ids ?? []) addSecret(id, PLACEHOLDERS.accountId);

  function buildRules(): Rule[] {
    const rules: Rule[] = [];
    if (secrets.tmpDir !== undefined && secrets.tmpDir !== '') {
      rules.push({
        pattern: new RegExp(`${pathPatternSource(secrets.tmpDir)}${SEP}${SCRATCH_DIR_NAME}`, 'gi'),
        replacement: PLACEHOLDERS.scratch,
      });
    }
    if (secrets.home !== undefined && secrets.home !== '') {
      rules.push({
        pattern: new RegExp(`${pathPatternSource(secrets.home)}(?![A-Za-z0-9])`, 'gi'),
        replacement: PLACEHOLDERS.home,
      });
    }
    // Longest secrets first, so an org name containing the e-mail wins over the e-mail.
    const known = [...learned.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [value, placeholder] of known) {
      rules.push({ pattern: new RegExp(escapeRegex(value), 'gi'), replacement: placeholder });
    }
    for (const pattern of TOKEN_PATTERNS) {
      rules.push({ pattern: new RegExp(pattern.source, pattern.flags), replacement: PLACEHOLDERS.token });
    }
    if (secrets.username !== undefined && secrets.username.length >= 3) {
      rules.push({ pattern: wordPattern(secrets.username), replacement: PLACEHOLDERS.user });
    }
    if (secrets.hostname !== undefined && secrets.hostname.length >= 4) {
      rules.push({ pattern: wordPattern(secrets.hostname), replacement: PLACEHOLDERS.host });
    }
    return rules;
  }

  let rules = buildRules();

  function text(input: string): string {
    let out = input;
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replacement);
    }
    return out.replace(EMAIL_PATTERN, (match) =>
      EMAIL_ALLOWLIST.has(match.toLowerCase()) ? match : PLACEHOLDERS.email,
    );
  }

  function placeholderForKey(key: string): string | undefined {
    if (/^apiKeySource$/i.test(key)) return undefined;
    return SENSITIVE_KEYS.find((entry) => entry.pattern.test(key))?.placeholder;
  }

  function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
  }

  function learnWalk(input: unknown, key: string | undefined): boolean {
    let changed = false;
    if (typeof input === 'string') {
      const placeholder = key === undefined ? undefined : placeholderForKey(key);
      const candidate = input.trim();
      // Enum-like values ("personal", "none", "claude_ai") are replaced in place but never learned:
      // replacing them everywhere would destroy unrelated text.
      const enumLike = /^[a-z_.-]+$/.test(candidate) && !candidate.includes('@');
      if (
        placeholder !== undefined &&
        placeholder !== PLACEHOLDERS.signature &&
        candidate.length >= 6 &&
        !enumLike &&
        !learned.has(candidate)
      ) {
        addSecret(candidate, placeholder);
        changed = learned.has(candidate);
      }
      return changed;
    }
    if (Array.isArray(input)) {
      for (const item of input) changed = learnWalk(item, key) || changed;
      return changed;
    }
    if (isRecord(input)) {
      for (const [childKey, child] of Object.entries(input)) changed = learnWalk(child, childKey) || changed;
    }
    return changed;
  }

  function learn(input: unknown): void {
    if (learnWalk(input, undefined)) rules = buildRules();
  }

  function valueWalk(
    input: unknown,
    key: string | undefined,
    parent: Record<string, unknown> | undefined,
  ): unknown {
    if (typeof input === 'string') {
      const placeholder = key === undefined ? undefined : placeholderForKey(key);
      if (placeholder !== undefined && input !== '') return placeholder;
      if (key === 'data' && parent?.type === 'redacted_thinking') return PLACEHOLDERS.redacted;
      return text(input);
    }
    if (Array.isArray(input)) return input.map((item) => valueWalk(item, undefined, undefined));
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(input)) {
        out[text(childKey)] = valueWalk(child, childKey, input);
      }
      return out;
    }
    return input;
  }

  function value(input: unknown): unknown {
    learn(input);
    return valueWalk(input, undefined, undefined);
  }

  function findLeaks(haystack: string): string[] {
    const leaks = findGenericLeaks(haystack);
    const lower = haystack.toLowerCase();
    for (const secret of learned.keys()) {
      if (lower.includes(secret.toLowerCase())) leaks.push(`known secret (${secret.length} chars)`);
    }
    for (const word of [secrets.username, secrets.hostname]) {
      if (word !== undefined && word.length >= 3 && wordPattern(word).test(haystack)) {
        leaks.push(`machine word (${word.length} chars)`);
      }
    }
    return leaks;
  }

  return { text, value, learn, findLeaks };
}
