/**
 * buildEnv() – the ONE environment builder for every `claude` process Parallax starts: SDK
 * session, terminal and external console (later phases), "Profil testen" and `pnpm preflight`
 * (Review C.2, A.7). Security relevant: Parallax itself is developed from inside Claude Code, so
 * the variables of the CALLING Claude session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, messaging
 * sockets/tokens …) and the run state of `pnpm run` must never leak into a started `claude`.
 *
 * Steps (in this order):
 *  1. Copy the base env (normally process.env), one spelling per name (Windows names are
 *     case-insensitive; the first spelling seen wins).
 *  2. Remove `CLAUDECODE`, `CLAUDE_CODE_*` (except CLAUDE_CODE_ENV_ALLOWLIST), `CLAUDE_PID`,
 *     `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `npm_*`, `PNPM_*`, `INIT_CWD`, `NODE_ENV`,
 *     `NODE_OPTIONS` and inherited `PARALLAX`/`PARALLAX_ENTRY_ID`; drop `node_modules\.bin`
 *     entries from PATH.
 *  3. Merge the profile env case-insensitively (`PATH` replaces `Path`). `${env:NAME}` refers to a
 *     variable of the machine: looked up in the cleaned env, then in the original base env (so a
 *     removed machine variable such as `${env:NPM_CONFIG_REGISTRY}` can be passed on on purpose).
 *  4. Set `PARALLAX=1`, `PARALLAX_ENTRY_ID`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`,
 *     `CLAUDE_AGENT_SDK_CLIENT_APP=parallax/<version>` and `CLAUDE_CONFIG_DIR` (profile.configDir).
 */
import path from 'node:path';
import type { EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { Profile } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { PRODUCT_ID } from '@shared/product';
import { CommandError } from '../sync/ports';

/**
 * `CLAUDE_CODE_*` variables that describe the machine (shell paths, provider selection,
 * enterprise auth), not the calling session; they are kept. C.2 names the first two "for example";
 * the provider/auth switches are kept so a machine-wide Bedrock/Vertex/Foundry setup keeps working
 * with the built-in profile. Everything else with this prefix is removed.
 */
export const CLAUDE_CODE_ENV_ALLOWLIST: readonly string[] = [
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
];

const ALLOWLIST: ReadonlySet<string> = new Set(CLAUDE_CODE_ENV_ALLOWLIST);

/** Removed by exact (upper-cased) name. */
const REMOVE_EXACT: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'INIT_CWD',
  'NODE_ENV',
  'NODE_OPTIONS',
  // Set by buildEnv itself; an inherited value (Parallax started from a Parallax session) never survives.
  'PARALLAX',
  'PARALLAX_ENTRY_ID',
]);

/** Removed by (upper-cased) prefix, unless allowlisted. */
const REMOVE_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'NPM_', 'PNPM_'];

/** A PATH entry pointing into a `node_modules\.bin` folder (pnpm/npm run state). */
const NODE_MODULES_BIN = /(?:^|[\\/])node_modules[\\/]\.bin[\\/]*$/i;

/** `${env:NAME}` reference in a profile env value. */
const ENV_REF = /\$\{env:([^}]*)\}/g;

/** Valid name of a profile env variable (no `=`, no NUL, not empty). */
const ENV_NAME = /^[^=\0]+$/;

export interface BuildEnvInput {
  /** Usually process.env (read at call time). */
  base: Readonly<Record<string, string | undefined>>;
  profile: Pick<Profile, 'env' | 'configDir'>;
  /** null for "Profil testen" / preflight (no entry): PARALLAX_ENTRY_ID is then not set. */
  entryId: EntryId | null;
  /** CLAUDE_AGENT_SDK_CLIENT_APP, see clientAppId(). */
  clientApp: string;
  /** PATH delimiter; defaults to the platform delimiter. */
  delimiter?: string;
}

export interface BuildEnvReport {
  env: Record<string, string>;
  /** Names of removed variables (spelling of the base env), sorted. */
  removed: string[];
  /** PATH entries dropped because they point into node_modules\.bin. */
  pathEntriesRemoved: number;
  /** Variables set by the builder itself (never profile env values, which may be secrets). */
  set: Record<string, string>;
  /** PROFILE_ENV_REF_UNRESOLVED {name, key}, PATH_REJECTED {reason, field}, VALIDATION_FAILED {path, key}. */
  issues: ErrorPayload[];
}

/** `parallax/<version>` for CLAUDE_AGENT_SDK_CLIENT_APP (User-Agent of the CLI). */
export function clientAppId(version: string): string {
  return `${PRODUCT_ID}/${version}`;
}

/** True if the variable must not reach a started `claude` (step 2). */
export function shouldRemoveEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  if (ALLOWLIST.has(upper)) return false;
  if (REMOVE_EXACT.has(upper)) return true;
  return REMOVE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Case-insensitive lookup (Windows env semantics). */
export function getEnvVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

/** Removes every spelling of `name`. */
export function deleteEnvVar(env: Record<string, string>, name: string): void {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) Reflect.deleteProperty(env, key);
  }
}

/** Sets `name` and drops any other spelling of it, so the child sees exactly one value. */
export function setEnvVar(env: Record<string, string>, name: string, value: string): void {
  deleteEnvVar(env, name);
  env[name] = value;
}

/** Drops `node_modules\.bin` entries; keeps all other entries (and their order) untouched. */
export function stripNodeModulesBin(value: string, delimiter: string): { value: string; removed: number } {
  const entries = value.split(delimiter);
  const kept = entries.filter((entry) => !NODE_MODULES_BIN.test(entry.trim().replace(/^"|"$/g, '')));
  return { value: kept.join(delimiter), removed: entries.length - kept.length };
}

/** Replaces `${env:NAME}` references; `missing` lists names that `lookup` does not know. */
export function resolveEnvRefs(
  value: string,
  lookup: (name: string) => string | undefined,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = value.replace(ENV_REF, (_match, name: string) => {
    const found = name === '' ? undefined : lookup(name);
    if (found === undefined) {
      missing.push(name);
      return '';
    }
    return found;
  });
  return { value: resolved, missing };
}

/** buildEnv without throwing: the environment plus what was removed/set and all issues. */
export function buildEnvReport(input: BuildEnvInput): BuildEnvReport {
  const delimiter = input.delimiter ?? path.delimiter;
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const removed: string[] = [];
  const issues: ErrorPayload[] = [];
  let pathEntriesRemoved = 0;

  // Steps 1 + 2: copy, one spelling per name, remove session and run-state variables.
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    if (shouldRemoveEnvVar(key)) {
      removed.push(key);
      continue;
    }
    if (upper === 'PATH') {
      const stripped = stripNodeModulesBin(value, delimiter);
      pathEntriesRemoved += stripped.removed;
      env[key] = stripped.value;
      continue;
    }
    env[key] = value;
  }

  // Step 3: profile env, case-insensitive, with ${env:NAME} against the machine env.
  const cleaned: Readonly<Record<string, string>> = { ...env };
  const lookup = (name: string): string | undefined =>
    getEnvVar(cleaned, name) ?? getEnvVar(input.base, name);
  for (const [key, raw] of Object.entries(input.profile.env)) {
    if (!ENV_NAME.test(key) || raw.includes('\0')) {
      issues.push(makeError('VALIDATION_FAILED', { path: 'profile.env', key }));
      continue;
    }
    const { value, missing } = resolveEnvRefs(raw, lookup);
    if (missing.length > 0) {
      for (const name of missing) issues.push(makeError('PROFILE_ENV_REF_UNRESOLVED', { name, key }));
      continue;
    }
    setEnvVar(env, key, value);
  }

  // Step 4: Parallax variables last.
  const set: Record<string, string> = { PARALLAX: '1' };
  if (input.entryId !== null) set.PARALLAX_ENTRY_ID = input.entryId;
  set.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  set.CLAUDE_AGENT_SDK_CLIENT_APP = input.clientApp;
  const configDir = input.profile.configDir;
  if (configDir !== null) {
    const issue = windowsPathIssue(configDir);
    if (issue === null) set.CLAUDE_CONFIG_DIR = configDir;
    else issues.push(makeError('PATH_REJECTED', { reason: issue, field: 'configDir' }));
  }
  if (input.entryId === null) deleteEnvVar(env, 'PARALLAX_ENTRY_ID');
  for (const [key, value] of Object.entries(set)) setEnvVar(env, key, value);

  removed.sort((a, b) => a.localeCompare(b));
  return { env, removed, pathEntriesRemoved, set, issues };
}

/**
 * The environment for one `claude` process. Throws CommandError with the first issue
 * (PROFILE_ENV_REF_UNRESOLVED {name, key}, PATH_REJECTED {reason, field: 'configDir'} …).
 */
export function buildEnv(input: BuildEnvInput): Record<string, string> {
  const report = buildEnvReport(input);
  const first = report.issues[0];
  if (first !== undefined) throw new CommandError(first);
  return report.env;
}
