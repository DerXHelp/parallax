/**
 * parseProfileArgs (C.12, Plan "Claude-Profile", C.3; pure, table-tested, no UI in Phase 1).
 *
 * `args` holds one argument per entry, unquoted. Forms: `--flag`, `--flag=value`, `--flag value`
 * (next entry). A value never starts with `-` unless given with `=` (`--append-system-prompt=-x`).
 *
 * - Allowlist (mapped to SDK options): `--model`, `--permission-mode`, `--settings`,
 *   `--append-system-prompt` (warning: no effect on resumed sessions), multi-value `--add-dir`,
 *   `--allowedTools`/`--allowed-tools`, `--disallowedTools`/`--disallowed-tools` (comma/space
 *   separated lists as in the CLI), `--mcp-config`, `--betas`, `--plugin-dir` (→ plugins).
 *   Multi-value flags take all following values and may repeat; every other flag may appear once.
 * - Bypass (C.3): `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and
 *   `--permission-mode bypassPermissions` set `allowDangerouslySkipPermissions` (never extraArgs)
 *   plus the warning PROFILE_BYPASS_ENABLED (the UI marks the profile red).
 * - Blocked (Parallax controls them): `-p`/`--print`, `--output-format`, `--input-format`,
 *   `-r`/`--resume`, `-c`/`--continue`, `--permission-prompt-tool`, `--replay-user-messages`,
 *   `--session-id`, `--fork-session`, `--setting-sources`, `--system-prompt*`, `--max-turns`,
 *   `--json-schema`, `--resume-session-at`, `-w`/`--worktree`, `--remote`, `--teleport`,
 *   `--sdk-url`, plus `-h`/`--help` and `-v`/`--version` (would end the process). Case-insensitive.
 * - Everything else: PROFILE_ARG_NOT_ALLOWED, or with `passRaw` ("roh durchreichen") into
 *   `extraArgs` (one value per flag, info PROFILE_ARG_PASSED_RAW). Short flags (`-x`) cannot be
 *   passed through the SDK's extraArgs and stay not allowed.
 * - Blanket `--allowedTools` entries (`Bash`, `Edit`, `*`, `Bash(*)`, `mcp__server` …) bypass
 *   canUseTool: warning PROFILE_ARG_BROAD_ALLOWED_TOOLS {value}.
 * Issue params (ProfileArgIssueParams): `index` (0-based position of the flag), `flag` (as
 * written), plus `reason` (PROFILE_ARG_INVALID) or `value`.
 */
import { modelNameSchema, permissionModeSchema } from '@shared/common';
import { makeError, type ErrorCode, type ErrorPayload, type ProfileArgInvalidReason } from '@shared/errors';
import { windowsPathIssue } from '@shared/paths';
import type { ParseProfileArgs, ProfileArgIssueParams, ProfileArgsResult, ProfileSdkOptions } from './ports';

type MultiKey =
  'additionalDirectories' | 'allowedTools' | 'disallowedTools' | 'mcpConfig' | 'betas' | 'plugins';
type SingleKey = 'model' | 'permissionMode' | 'settings' | 'appendSystemPrompt';

type FlagSpec =
  | { kind: 'single'; key: SingleKey }
  | { kind: 'multi'; key: MultiKey; split?: 'tools'; path?: true }
  | { kind: 'bypass' };

/** SDK-mapped flags (exact spelling, as the CLI is case-sensitive). */
const MAPPED: Readonly<Record<string, FlagSpec>> = {
  '--model': { kind: 'single', key: 'model' },
  '--permission-mode': { kind: 'single', key: 'permissionMode' },
  '--settings': { kind: 'single', key: 'settings' },
  '--append-system-prompt': { kind: 'single', key: 'appendSystemPrompt' },
  '--add-dir': { kind: 'multi', key: 'additionalDirectories', path: true },
  '--allowedTools': { kind: 'multi', key: 'allowedTools', split: 'tools' },
  '--allowed-tools': { kind: 'multi', key: 'allowedTools', split: 'tools' },
  '--disallowedTools': { kind: 'multi', key: 'disallowedTools', split: 'tools' },
  '--disallowed-tools': { kind: 'multi', key: 'disallowedTools', split: 'tools' },
  '--mcp-config': { kind: 'multi', key: 'mcpConfig' },
  '--betas': { kind: 'multi', key: 'betas' },
  '--plugin-dir': { kind: 'multi', key: 'plugins', path: true },
  '--dangerously-skip-permissions': { kind: 'bypass' },
  '--allow-dangerously-skip-permissions': { kind: 'bypass' },
};

/** Lower-case; flags controlled by Parallax (Plan "Claude-Profile" + C.12). */
export const BLOCKED_PROFILE_FLAGS: readonly string[] = [
  '-p',
  '--print',
  '--output-format',
  '--input-format',
  '-r',
  '--resume',
  '-c',
  '--continue',
  '--permission-prompt-tool',
  '--replay-user-messages',
  '--session-id',
  '--fork-session',
  '--setting-sources',
  '--max-turns',
  '--json-schema',
  '--resume-session-at',
  '-w',
  '--worktree',
  '--remote',
  '--teleport',
  '--sdk-url',
  '-h',
  '--help',
  '-v',
  '--version',
];
const BLOCKED: ReadonlySet<string> = new Set(BLOCKED_PROFILE_FLAGS);
/** Blocked by prefix (`--system-prompt`, `--system-prompt-file` …). */
const BLOCKED_PREFIXES: readonly string[] = ['--system-prompt'];
const BLOCKED_SHORT: ReadonlySet<string> = new Set(
  BLOCKED_PROFILE_FLAGS.filter((flag) => /^-[a-z]$/.test(flag)).map((flag) => flag.slice(1)),
);

const RAW_FLAG = /^--[A-Za-z0-9][A-Za-z0-9_-]*$/;
const NOT_A_FLAG_PREVIEW_CHARS = 40;

function isBlocked(flag: string): boolean {
  const lower = flag.toLowerCase();
  if (BLOCKED.has(lower) || BLOCKED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  // Combined short flags (`-pc`) are blocked if any letter is.
  return /^-[a-z]+$/i.test(flag) && Array.from(lower.slice(1)).some((letter) => BLOCKED_SHORT.has(letter));
}

/** Splits a CLI tool list at commas/whitespace outside parentheses (`Bash(npm run x) Edit`). */
export function splitToolList(value: string): string[] {
  const tools: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      if (current !== '') tools.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') tools.push(current);
  return tools;
}

/**
 * True for an allow rule that permits a whole tool (or everything) and so bypasses canUseTool for
 * all its calls: `*`, `Bash`, `Edit`, `Bash(*)`, `Bash(:*)`, `Edit(**)`, `mcp__server`,
 * `mcp__server__*`. Not broad: `Bash(git status:*)`, `Read(./docs/**)`, `mcp__server__tool`.
 */
export function isBroadToolRule(rule: string): boolean {
  const match = /^([^()]*)(?:\((.*)\))?$/s.exec(rule.trim());
  if (match === null) return false;
  const name = (match[1] ?? '').trim();
  const specifier = match[2]?.trim();
  if (name === '*' || name === '') return true;
  if (specifier === undefined) {
    if (/^mcp__.+__.+$/.test(name)) return name.endsWith('__*');
    return true;
  }
  return ['', '*', ':*', '**', '*:*'].includes(specifier);
}

/** Parses profile.args (C.12). Implements the port `ParseProfileArgs`. */
export const parseProfileArgs: ParseProfileArgs = (args, passRaw) => {
  const sdkOptions: ProfileSdkOptions = {};
  const extraArgs: Record<string, string | null> = {};
  const warnings: ErrorPayload[] = [];
  const errors: ErrorPayload[] = [];
  const seenSingle = new Set<string>();
  let allowDangerouslySkipPermissions = false;

  const issue = (
    code: ErrorCode,
    index: number,
    flag: string,
    extra: Record<string, string> = {},
  ): ErrorPayload => {
    const params: ProfileArgIssueParams = { index, flag, ...extra };
    return makeError(code, params);
  };
  const invalid = (index: number, flag: string, reason: ProfileArgInvalidReason): void => {
    errors.push(issue('PROFILE_ARG_INVALID', index, flag, { reason }));
  };
  const isValue = (entry: string | undefined): entry is string =>
    entry !== undefined && !entry.startsWith('-');

  let i = 0;
  while (i < args.length) {
    const index = i;
    const entry = args[i] ?? '';
    i += 1;

    if (!entry.startsWith('-') || entry === '-' || entry === '--') {
      invalid(index, entry.slice(0, NOT_A_FLAG_PREVIEW_CHARS), 'not_a_flag');
      continue;
    }

    const eq = entry.startsWith('--') ? entry.indexOf('=') : -1;
    const flag = eq === -1 ? entry : entry.slice(0, eq);
    const inline = eq === -1 ? undefined : entry.slice(eq + 1);

    if (isBlocked(flag)) {
      errors.push(issue('PROFILE_ARG_BLOCKED', index, flag));
      if (inline === undefined && isValue(args[i])) i += 1; // its value, if any
      continue;
    }

    const spec = Object.hasOwn(MAPPED, flag) ? MAPPED[flag] : undefined;
    if (spec === undefined) {
      if (!passRaw || !RAW_FLAG.test(flag)) {
        if (passRaw && flag.startsWith('--')) invalid(index, flag, 'not_a_flag');
        else errors.push(issue('PROFILE_ARG_NOT_ALLOWED', index, flag));
        if (inline === undefined && isValue(args[i])) i += 1;
        continue;
      }
      let value: string | null = inline ?? null;
      if (inline === undefined && isValue(args[i])) {
        value = args[i] ?? null;
        i += 1;
      }
      const key = flag.slice(2);
      if (Object.hasOwn(extraArgs, key)) {
        invalid(index, flag, 'duplicate');
        continue;
      }
      if (value?.includes('\0') === true) {
        invalid(index, flag, 'invalid_value');
        continue;
      }
      extraArgs[key] = value;
      warnings.push(issue('PROFILE_ARG_PASSED_RAW', index, flag));
      continue;
    }

    if (spec.kind === 'bypass') {
      if (inline !== undefined) {
        invalid(index, flag, 'unexpected_value');
        continue;
      }
      if (seenSingle.has(flag)) {
        invalid(index, flag, 'duplicate');
        continue;
      }
      seenSingle.add(flag);
      allowDangerouslySkipPermissions = true;
      warnings.push(issue('PROFILE_BYPASS_ENABLED', index, flag));
      continue;
    }

    // Collect the value(s).
    const values: string[] = [];
    if (inline !== undefined) {
      values.push(inline);
    } else if (spec.kind === 'single') {
      if (isValue(args[i])) {
        values.push(args[i] ?? '');
        i += 1;
      }
    } else {
      while (isValue(args[i])) {
        values.push(args[i] ?? '');
        i += 1;
      }
    }
    if (values.length === 0 || values.some((value) => value.trim() === '')) {
      invalid(index, flag, 'missing_value');
      continue;
    }
    if (values.some((value) => value.includes('\0'))) {
      invalid(index, flag, 'invalid_value');
      continue;
    }

    if (spec.kind === 'single') {
      if (seenSingle.has(spec.key)) {
        invalid(index, flag, 'duplicate');
        continue;
      }
      seenSingle.add(spec.key);
      const value = values[0] ?? '';
      switch (spec.key) {
        case 'model': {
          const model = modelNameSchema.safeParse(value);
          if (model.success) sdkOptions.model = model.data;
          else invalid(index, flag, 'invalid_value');
          break;
        }
        case 'permissionMode': {
          const mode = permissionModeSchema.safeParse(value);
          if (!mode.success) {
            invalid(index, flag, 'invalid_value');
            break;
          }
          sdkOptions.permissionMode = mode.data;
          if (mode.data === 'bypassPermissions') {
            allowDangerouslySkipPermissions = true;
            warnings.push(issue('PROFILE_BYPASS_ENABLED', index, flag));
          }
          break;
        }
        case 'settings':
          sdkOptions.settings = value;
          break;
        case 'appendSystemPrompt':
          sdkOptions.appendSystemPrompt = value;
          warnings.push(issue('PROFILE_ARG_RESUME_NO_EFFECT', index, flag));
          break;
      }
      continue;
    }

    // Multi-value flag.
    const items = spec.split === 'tools' ? values.flatMap(splitToolList) : values;
    if (items.length === 0) {
      invalid(index, flag, 'missing_value');
      continue;
    }
    if (spec.path === true && items.some((item) => windowsPathIssue(item) !== null)) {
      invalid(index, flag, 'invalid_value');
      continue;
    }
    const list = sdkOptions[spec.key] ?? [];
    list.push(...items);
    sdkOptions[spec.key] = list;
    if (spec.key === 'allowedTools') {
      for (const item of items) {
        if (isBroadToolRule(item))
          warnings.push(issue('PROFILE_ARG_BROAD_ALLOWED_TOOLS', index, flag, { value: item }));
      }
    }
  }

  const result: ProfileArgsResult = {
    sdkOptions,
    extraArgs,
    allowDangerouslySkipPermissions,
    warnings,
    errors,
  };
  return result;
};
