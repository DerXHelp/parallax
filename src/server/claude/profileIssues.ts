/**
 * profileIssues (ADR-102, WP-30 §4.5; pure, table-tested): the findings of a profile or of an
 * unsaved profile input. The server decides the level:
 * - `error` (blocks save, start, becoming default): the `errors` of parseProfileArgs
 *   (PROFILE_ARG_BLOCKED / _NOT_ALLOWED / _INVALID with ProfileArgIssueParams), an unusable
 *   executable path (PROFILE_INVALID {field:'executable', reason}), an unsafe configDir
 *   (PROFILE_INVALID {field:'configDir', reason:'unsafe'}) and env entries buildEnv cannot set
 *   (VALIDATION_FAILED {path:'profile.env', key} – e.g. a NUL in a hand-edited value).
 * - `warning`: parseProfileArgs warnings of severity warning (broad allowedTools, bypass,
 *   resume-no-effect) and `${env:NAME}` references this machine does not resolve
 *   (PROFILE_ENV_REF_UNRESOLVED {name, key}; a start then fails until the variable exists).
 * - `info`: PROFILE_ARG_PASSED_RAW.
 * A missing configDir folder is no finding (the CLI creates it at the login).
 */
import { errorSpec, makeError, type ErrorPayload } from '@shared/errors';
import type { Profile, ProfileExecutable, ProfileInput, ProfileIssue } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { buildEnvReport } from './env';
import { parseProfileArgs } from './profileArgs';

/** Reasons of PROFILE_INVALID {field:'executable'}. */
export type ExecutableIssueReason = 'not_absolute' | 'not_exe' | 'unsafe' | 'not_found';

export interface ProfileIssueContext {
  /** Machine environment for `${env:NAME}` (normally process.env). */
  env: NodeJS.ProcessEnv;
  /** Persistent environment (HKCU/HKLM, upper-cased names) – the buildEnv exception (ADR-021). */
  persistentEnv: ReadonlyMap<string, string>;
  /** True for an existing file; only called with safe absolute `.exe` paths. */
  exists(path: string): boolean;
}

/** The reason an `executable` cannot be used, or null (`auto` is always fine). */
export function executableIssue(
  executable: ProfileExecutable,
  exists: (path: string) => boolean,
): ExecutableIssueReason | null {
  if (executable.kind === 'auto') return null;
  const file = executable.path;
  const pathIssue = windowsPathIssue(file);
  if (pathIssue === 'not_absolute' || pathIssue === 'empty') return 'not_absolute';
  if (pathIssue !== null) return 'unsafe';
  if (!/\.exe$/i.test(file)) return 'not_exe';
  return exists(file) ? null : 'not_found';
}

const issue = (level: ProfileIssue['level'], payload: ErrorPayload): ProfileIssue => ({
  level,
  issue: payload,
});

/** All findings, errors first, then warnings, then infos (each in the order found). */
export function profileIssues(profile: Profile | ProfileInput, ctx: ProfileIssueContext): ProfileIssue[] {
  const errors: ProfileIssue[] = [];
  const warnings: ProfileIssue[] = [];
  const infos: ProfileIssue[] = [];

  const args = parseProfileArgs(profile.args, profile.passRawArgs);
  for (const error of args.errors) errors.push(issue('error', error));

  const executable = executableIssue(profile.executable, (file) => ctx.exists(file));
  if (executable !== null) {
    errors.push(issue('error', makeError('PROFILE_INVALID', { field: 'executable', reason: executable })));
  }
  if (profile.configDir !== null && windowsPathIssue(profile.configDir) !== null) {
    errors.push(issue('error', makeError('PROFILE_INVALID', { field: 'configDir', reason: 'unsafe' })));
  }

  // The env exactly as buildEnv would merge it (configDir is checked above, not twice).
  const report = buildEnvReport({
    base: ctx.env,
    profile: { env: profile.env, configDir: null },
    entryId: null,
    clientApp: 'parallax',
    persistent: ctx.persistentEnv,
  });
  for (const warning of args.warnings) {
    if (errorSpec(warning.code).severity === 'info') infos.push(issue('info', warning));
    else warnings.push(issue('warning', warning));
  }
  for (const envIssue of report.issues) {
    if (envIssue.code === 'PROFILE_ENV_REF_UNRESOLVED') warnings.push(issue('warning', envIssue));
    else errors.push(issue('error', envIssue));
  }
  return [...errors, ...warnings, ...infos];
}

/** Number of `level: 'error'` findings (PROFILE_INVALID {count}). */
export function errorCount(issues: readonly ProfileIssue[]): number {
  return issues.filter((finding) => finding.level === 'error').length;
}
