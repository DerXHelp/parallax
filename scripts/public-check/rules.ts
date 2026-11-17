/**
 * Rules of the public-repo check (WP-84): pure functions over text, no I/O.
 *
 * A finding names the place and the rule, never the matched text: CI logs of a public repo are
 * public, and terms of the local list must not reach any output.
 */

export type RuleId =
  | 'user-path'
  | 'os-user'
  | 'repo-path'
  | 'email'
  | 'session-link'
  | 'secret'
  | 'private-term'
  | 'attribution'
  | 'identity';

export interface TextFinding {
  /** 1-based line of the match. */
  line: number;
  rule: RuleId;
}

export interface EnvironmentPattern {
  rule: RuleId;
  pattern: RegExp;
}

export interface ScanContext {
  /** Whole-word patterns of the local list (see `privateTermPatterns`). */
  privateTerms: readonly RegExp[];
  /** Patterns derived from this machine: OS user name, absolute checkout paths. */
  environment: readonly EnvironmentPattern[];
}

/** Invented names that tests and docs use in `C:\Users\<name>` paths. */
const ALLOWED_USER_NAMES = new Set([
  'user',
  'users',
  'username',
  'user.claude',
  'fake-user',
  'name',
  'me',
  'x',
  'u',
  'ich',
  'ja',
  'dev',
  'max',
  'jane',
  'jane.doe',
  'jonas',
  'vorname',
  'someone',
  'public',
  'default',
  'all users',
  'runneradmin',
]);

/** First characters that mark a placeholder instead of a name (`<USER>`, `%USERNAME%`, `…`). */
const PLACEHOLDER_START = /^[<%${…*.]/u;

/** `C:\Users\name`, `C:\\Users\\name` (escaped), `C:/Users/name`, `/c/Users/name`. */
const USER_PATH =
  /(?<![A-Za-z0-9])(?:[A-Za-z]:|\/[A-Za-z])(?:\\{1,4}|\/)users(?:\\{1,4}|\/)([^\\/\s"'`),;:|*?\]]*)/giu;
/** Folder names of `~/.claude/projects` (`C--Users-name-…`). */
const USER_SLUG = /(?<![A-Za-z0-9])[A-Za-z]--users-([^-\s\\/"'`]+)/giu;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
/** "TLDs" that are file names (`u200b@README.md`, `pkg@index.ts`). */
const FILE_EXTENSIONS = new Set([
  'md',
  'ts',
  'tsx',
  'js',
  'mjs',
  'cjs',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'txt',
  'css',
  'html',
  'png',
  'svg',
  'cmd',
  'exe',
  'ps1',
  'sh',
]);
const ALLOWED_EMAILS = new Set(['git@github.com']);

const SESSION_LINK = /claude\.ai\/(?:code\/session_|chat\/|share\/|project\/)([A-Za-z0-9_-]+)/giu;
const SESSION_ID_MIN = 16;
const INVENTED_ID = /fake|example/iu;

/** Real keys are long; short test strings like `sk-ant-abcdefghijkl` (redaction tests) stay allowed. */
const SECRETS: readonly RegExp[] = [
  /sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{20,}/gu,
  /sk-ant-[A-Za-z0-9_-]{30,}/gu,
  /-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-{5}/gu,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/gu,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/gu,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/gu,
];

/** Trailers that attribute a commit to Claude; new commits must not carry them (WP-84). */
const ATTRIBUTION = /^(?:co-authored-by:.*(?:claude|anthropic)|claude-session:)/gimu;

/** OS user names too generic to search for as a word (they would match ordinary text). */
const GENERIC_USER_NAMES = new Set([
  'user',
  'admin',
  'administrator',
  'runner',
  'runneradmin',
  'test',
  'dev',
  'owner',
  'guest',
  'default',
  'public',
  'root',
  'node',
  'docker',
  'vagrant',
  'ubuntu',
  'pi',
]);

const MIN_TERM_LENGTH = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
}

/** Whole word, case-insensitive: no letter or digit directly before or after. */
function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Lines of the local list: one term per line, `#` starts a comment line, blank lines are skipped. */
export function parsePrivateList(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_TERM_LENGTH && !line.startsWith('#'));
}

export function privateTermPatterns(terms: readonly string[]): RegExp[] {
  return terms.map(wordPattern);
}

/**
 * Patterns of this machine: the OS user name as a word (unless generic) and each absolute checkout
 * path in its spellings (`D:\a\b`, `D:\\a\\b`, `D:/a/b`, `/d/a/b`, `D--a-b`).
 */
export function environmentPatterns(options: {
  userName: string | null;
  checkoutPaths: readonly string[];
}): EnvironmentPattern[] {
  const patterns: EnvironmentPattern[] = [];
  const userName = options.userName?.trim() ?? '';
  if (userName.length >= 3 && !GENERIC_USER_NAMES.has(userName.toLowerCase())) {
    patterns.push({ rule: 'os-user', pattern: wordPattern(userName) });
  }
  const seen = new Set<string>();
  for (const checkout of options.checkoutPaths) {
    const match = /^([A-Za-z]):[\\/]+(.+?)[\\/]*$/u.exec(checkout);
    if (match === null) continue;
    const drive = match[1] ?? '';
    const segments = (match[2] ?? '').split(/[\\/]+/u).filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const key = `${drive}:${segments.join('/')}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const separator = String.raw`(?:\\{1,4}|/)`;
    const path = `(?:${drive}:|/${drive})${separator}${segments.map(escapeRegExp).join(separator)}`;
    const slug = `${drive}--${segments.map((s) => escapeRegExp(s.replace(/[^A-Za-z0-9]/gu, '-'))).join('-')}`;
    patterns.push({
      rule: 'repo-path',
      pattern: new RegExp(`(?<![A-Za-z0-9])(?:${path}|${slug})(?![\\p{L}\\p{N}])`, 'giu'),
    });
  }
  return patterns;
}

/** Start offsets of all lines, for offset → line lookups. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function isAllowedUserName(name: string): boolean {
  return name.length === 0 || PLACEHOLDER_START.test(name) || ALLOWED_USER_NAMES.has(name.toLowerCase());
}

/** True if the address sits in a URL (`https://user:secret@host`, `https://evil.com@claude.ai`). */
function isUrlUserInfo(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/[\s"'`(<>[\]{}]/u.test(text[start - 1] ?? '')) start--;
  return text.slice(start, index).includes('//');
}

function isAllowedEmail(text: string, match: RegExpExecArray): boolean {
  const address = match[0].toLowerCase();
  if (ALLOWED_EMAILS.has(address)) return true;
  const [local = '', domain = ''] = address.split('@');
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (FILE_EXTENSIONS.has(tld)) return true;
  if (local.includes('noreply') || local.includes('no-reply') || domain.includes('noreply')) return true;
  if (
    domain === 'example' ||
    domain.endsWith('.example') ||
    /(?:^|\.)example\.(?:com|org|net)$/u.test(domain) ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.test') ||
    domain.endsWith('.localhost')
  ) {
    return true;
  }
  return isUrlUserInfo(text, match.index);
}

/**
 * Findings of one text (file content, blob, commit message, path). `attribution` only applies to
 * commit messages.
 */
export function scanText(
  text: string,
  context: ScanContext,
  options: { commitMessage?: boolean } = {},
): TextFinding[] {
  const found: { offset: number; rule: RuleId }[] = [];
  const each = (
    pattern: RegExp,
    rule: RuleId,
    keep: (match: RegExpExecArray) => boolean = () => true,
  ): void => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (keep(match)) found.push({ offset: match.index, rule });
      if (match[0].length === 0) pattern.lastIndex++;
    }
  };
  each(USER_PATH, 'user-path', (m) => !isAllowedUserName(m[1] ?? ''));
  each(USER_SLUG, 'user-path', (m) => !isAllowedUserName(m[1] ?? ''));
  each(EMAIL, 'email', (m) => !isAllowedEmail(text, m));
  each(SESSION_LINK, 'session-link', (m) => {
    const id = m[1] ?? '';
    return id.length >= SESSION_ID_MIN && !INVENTED_ID.test(id);
  });
  for (const secret of SECRETS) each(secret, 'secret');
  for (const term of context.privateTerms) each(term, 'private-term');
  for (const { rule, pattern } of context.environment) each(pattern, rule);
  if (options.commitMessage === true) each(ATTRIBUTION, 'attribution');
  if (found.length === 0) return [];
  const starts = lineStarts(text);
  const unique = new Map<string, TextFinding>();
  for (const { offset, rule } of found) {
    const line = lineOf(starts, offset);
    unique.set(`${line}:${rule}`, { line, rule });
  }
  return [...unique.values()].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Addresses allowed as commit author or committer: GitHub's noreply forms only. */
export function isAllowedIdentityEmail(email: string): boolean {
  const address = email.trim().toLowerCase();
  return address === 'noreply@github.com' || /^[^@\s]+@users\.noreply\.github\.com$/u.test(address);
}

/** True if a text (e.g. a path) contains a term of the local list – then it is never printed. */
export function containsPrivateTerm(text: string, context: ScanContext): boolean {
  return context.privateTerms.some((term) => {
    term.lastIndex = 0;
    return term.test(text);
  });
}
