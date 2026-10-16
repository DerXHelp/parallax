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
 *  2. Remove (envRemovalReason):
 *     - `session` – markers of the calling Claude session: `CLAUDECODE`, `CLAUDE_CODE_*` (except
 *       CLAUDE_CODE_ENV_ALLOWLIST), `CLAUDE_AGENT_SDK_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
 *       `AI_AGENT` (R1-03), the hook/plugin context `CLAUDE_PROJECT_DIR`, `CLAUDE_ENV_FILE`,
 *       `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, and EVERY inherited `PARALLAX`/`PARALLAX_*`
 *       (WP22-07: the server's own control variables `PARALLAX_HOME`, `PARALLAX_PORT`,
 *       `PARALLAX_BACKEND`, `PARALLAX_LIVE`, `PARALLAX_VALIDATE`, `PARALLAX_DEV_WEB_PORT` … – a
 *       `pnpm test`/`pnpm start` in a session tool must never reach the running server's home);
 *     - `run_state` – what `pnpm run`/`npm run` set: `INIT_CWD`, `npm_lifecycle_*`,
 *       `npm_package_*`, `npm_execpath`, `npm_node_execpath`, `npm_command`,
 *       `npm_config_user_agent`, `npm_config_node_gyp`, `PNPM_SCRIPT_SRC_DIR`, `PNPM_PACKAGE_NAME`,
 *       `pnpm_config_verify_deps_before_run`;
 *     - `machine_overridable` – every other `npm_*`/`PNPM_*`, `NODE_ENV`, `NODE_OPTIONS`: KEPT when
 *       the same name is defined persistently (HKCU/HKLM `Environment`) with exactly the same
 *       value (Nexus: `NPM_CONFIG_REGISTRY`, `PNPM_HOME`; ADR-021). `session` and `run_state`
 *       names are removed even when they are persistent.
 *     - target `terminal` only, when the base env comes from a Claude session (`CLAUDECODE` set):
 *       the tool-shell settings of that session (`GIT_EDITOR=true`, `GIT_TERMINAL_PROMPT=0`,
 *       `GCM_INTERACTIVE`, `NO_COLOR`, …, TERMINAL_TOOL_SHELL_VARS) – same persistence exception.
 *     Drop `node_modules\.bin` entries from PATH. `NoDefaultCurrentDirectoryInExePath` is kept.
 *  3. Merge the profile env case-insensitively (`PATH` replaces `Path`). `${env:NAME}` refers to a
 *     variable of the machine: looked up in the cleaned env, then in the original base env (so a
 *     removed machine variable such as `${env:NPM_CONFIG_REGISTRY}` can be passed on on purpose).
 *  4. Set `PARALLAX=1`, `PARALLAX_ENTRY_ID`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`,
 *     `CLAUDE_AGENT_SDK_CLIENT_APP=parallax/<version>` and `CLAUDE_CONFIG_DIR` (profile.configDir).
 *     These two are the only `PARALLAX*` names a started `claude` ever sees (a profile env value
 *     with a `PARALLAX_*` name is set on purpose and kept).
 */
import path from 'node:path';
import type { EntryId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { Profile } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { PRODUCT_ID } from '@shared/product';
import type { PersistentEnvironment } from '../lib/registry';
import { getEnvVar } from '../lib/windows';
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

/**
 * Why step 2 removes a variable. `session`/`run_state` are always removed; `machine_overridable`
 * and `tool_shell` survive when defined persistently with the same value (ADR-021).
 */
export type EnvRemovalReason = 'session' | 'run_state' | 'machine_overridable' | 'tool_shell';

/** Markers of the calling Claude session (exact, upper-cased). Never kept, even if persistent. */
const SESSION_EXACT: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  // `claude-code_<version>_agent` – identifies the calling session's version and role (R1-03).
  'AI_AGENT',
  // Hook/plugin context of the calling session (paths of its project, env file, plugin).
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_ENV_FILE',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  // Set by buildEnv itself; an inherited value (Parallax started from a Parallax session) never survives.
  'PARALLAX',
]);

/**
 * Session prefixes (upper-cased), unless allowlisted. Never kept, even if persistent. `PARALLAX_`:
 * every control variable of the server environment (WP22-07) – buildEnv sets PARALLAX_ENTRY_ID
 * itself in step 4.
 */
const SESSION_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'PARALLAX_'];

/** Run state of `pnpm run` / `npm run` (exact, upper-cased; as observed with pnpm 12.8). Never kept. */
const RUN_STATE_EXACT: ReadonlySet<string> = new Set([
  'INIT_CWD',
  'NPM_COMMAND',
  'NPM_EXECPATH',
  'NPM_NODE_EXECPATH',
  'NPM_CONFIG_USER_AGENT',
  'NPM_CONFIG_NODE_GYP',
  'PNPM_SCRIPT_SRC_DIR',
  'PNPM_PACKAGE_NAME',
  'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN',
]);

const RUN_STATE_PREFIXES: readonly string[] = ['NPM_LIFECYCLE_', 'NPM_PACKAGE_'];

/** Removed unless persistent with the same value (C.2 + ADR-021). */
const MACHINE_OVERRIDABLE_EXACT: ReadonlySet<string> = new Set(['NODE_ENV', 'NODE_OPTIONS']);
const MACHINE_OVERRIDABLE_PREFIXES: readonly string[] = ['NPM_', 'PNPM_'];

/**
 * Tool-shell settings Claude Code puts into the environment of its own Bash/PowerShell tools
 * (observed names in a Claude Code 2.1.299 session, not set persistently there). Harmless for an
 * SDK session (the started claude sets them for its tools anyway), but they break an interactive
 * terminal (`git commit` without -m, credential prompts, colors) – removed for target `terminal`
 * when the base env comes from a Claude session (R1-03, Phase 2).
 */
export const TERMINAL_TOOL_SHELL_VARS: readonly string[] = [
  'GIT_EDITOR',
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
  'GCM_INTERACTIVE',
  'COREPACK_ENABLE_AUTO_PIN',
  'NO_COLOR',
  'PYTHONIOENCODING',
  'PSEXECUTIONPOLICYPREFERENCE',
];
const TERMINAL_TOOL_SHELL: ReadonlySet<string> = new Set(TERMINAL_TOOL_SHELL_VARS);

const hasPrefix = (upper: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => upper.startsWith(prefix));

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
  /**
   * Persistent environment (HKCU/HKLM `Environment`, lib/registry.ts readPersistentEnvironment;
   * upper-cased names). Default null = no exception: every removable name is removed.
   */
  persistent?: PersistentEnvironment | null;
  /** `sdk` (default): SDK session, "Profil testen", preflight. `terminal`: interactive terminal/console (Phase 2). */
  target?: 'sdk' | 'terminal';
}

export interface BuildEnvReport {
  env: Record<string, string>;
  /** Names of removed variables (spelling of the base env), sorted. */
  removed: string[];
  /** Removable names kept because they are defined persistently with the same value (ADR-021), sorted. */
  keptPersistent: string[];
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

/** Removal rule of step 2 for `name` (target `sdk`), or null if it is always kept. */
export function envRemovalReason(name: string): Exclude<EnvRemovalReason, 'tool_shell'> | null {
  const upper = name.toUpperCase();
  if (ALLOWLIST.has(upper)) return null;
  if (SESSION_EXACT.has(upper) || hasPrefix(upper, SESSION_PREFIXES)) return 'session';
  if (RUN_STATE_EXACT.has(upper) || hasPrefix(upper, RUN_STATE_PREFIXES)) return 'run_state';
  if (MACHINE_OVERRIDABLE_EXACT.has(upper) || hasPrefix(upper, MACHINE_OVERRIDABLE_PREFIXES)) {
    return 'machine_overridable';
  }
  return null;
}

/** True if the variable is removable in step 2 (without the persistence exception). */
export function shouldRemoveEnvVar(name: string): boolean {
  return envRemovalReason(name) !== null;
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
  const keptPersistent: string[] = [];
  const issues: ErrorPayload[] = [];
  let pathEntriesRemoved = 0;
  const persistent = input.persistent ?? null;
  const terminalInClaude = input.target === 'terminal' && getEnvVar(input.base, 'CLAUDECODE') !== undefined;

  // Steps 1 + 2: copy, one spelling per name, remove session and run-state variables.
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const reason: EnvRemovalReason | null =
      envRemovalReason(key) ?? (terminalInClaude && TERMINAL_TOOL_SHELL.has(upper) ? 'tool_shell' : null);
    if (reason !== null) {
      const overridable = reason === 'machine_overridable' || reason === 'tool_shell';
      if (overridable && persistent !== null && persistent.get(upper) === value) {
        keptPersistent.push(key);
        env[key] = value;
      } else {
        removed.push(key);
      }
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
  keptPersistent.sort((a, b) => a.localeCompare(b));
  return { env, removed, keptPersistent, pathEntriesRemoved, set, issues };
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
