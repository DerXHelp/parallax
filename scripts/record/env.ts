/**
 * Spike-local minimal env builder for live `claude` runs of the fixture recorder (WP-01).
 *
 * The real `buildEnv()` (profiles, case-insensitive merge of profile env, `${env:NAME}`) is built
 * in src/server/claude by WP-11. This version only guarantees that the recorder never leaks the
 * calling Claude session's variables (or npm/pnpm run state, or an API key) into the spawned CLI.
 */
import path from 'node:path';

/** CLAUDE_CODE_* variables that describe the machine, not the calling session; they are kept. */
export const CLAUDE_CODE_ALLOWLIST: ReadonlySet<string> = new Set([
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
]);

/** Removed by exact (upper-cased) name. */
const REMOVE_EXACT: ReadonlySet<string> = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'INIT_CWD',
  'NODE_ENV',
  'NODE_OPTIONS',
  // Spike only: the recorder must use the subscription login, never an API key or a gateway.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // Recorder's own guard flag; the CLI does not need it.
  'PARALLAX_LIVE',
]);

/** Removed by (upper-cased) prefix, unless allowlisted. */
const REMOVE_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'NPM_', 'PNPM_'];

const NODE_MODULES_BIN = /[\\/]node_modules[\\/]\.bin[\\/]?$/i;

export interface SpikeEnvOptions {
  /** Value of PARALLAX_ENTRY_ID (default `spike`). */
  entryId?: string;
  /** Client app id for the User-Agent (default `parallax/0.0.0-spike`). */
  clientApp?: string;
  /** Additional variables set last (case-insensitive replace), e.g. PARALLAX_HOME. */
  extra?: Readonly<Record<string, string>>;
  /** PATH delimiter; defaults to the platform delimiter. */
  delimiter?: string;
}

export interface SpikeEnvResult {
  env: Record<string, string>;
  /** Names of removed variables (original spelling), sorted. */
  removed: string[];
  /** Number of PATH entries dropped because they point into node_modules\.bin. */
  pathEntriesRemoved: number;
  /** Variables set by the builder (values are not secret). */
  set: Record<string, string>;
}

function shouldRemove(upper: string): boolean {
  if (CLAUDE_CODE_ALLOWLIST.has(upper)) return false;
  if (REMOVE_EXACT.has(upper)) return true;
  return REMOVE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Sets `key` and drops any other spelling of the same name (Windows env names are case-insensitive). */
function setCaseInsensitive(env: Record<string, string>, key: string, value: string): void {
  const upper = key.toUpperCase();
  for (const existing of Object.keys(env)) {
    if (existing !== key && existing.toUpperCase() === upper) {
      Reflect.deleteProperty(env, existing);
    }
  }
  env[key] = value;
}

/**
 * Builds the environment for one spike `claude` process from `base` (usually `process.env`).
 * Duplicate spellings of one name (`Path` and `PATH` in a plain object) keep the first one seen.
 */
export function buildSpikeEnv(base: NodeJS.ProcessEnv, options: SpikeEnvOptions = {}): SpikeEnvResult {
  const delimiter = options.delimiter ?? path.delimiter;
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const removed: string[] = [];
  let pathEntriesRemoved = 0;

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    if (shouldRemove(upper)) {
      removed.push(key);
      continue;
    }
    if (upper === 'PATH') {
      const entries = value.split(delimiter);
      const kept = entries.filter((entry) => !NODE_MODULES_BIN.test(entry.trim()));
      pathEntriesRemoved += entries.length - kept.length;
      env[key] = kept.join(delimiter);
      continue;
    }
    env[key] = value;
  }

  const set: Record<string, string> = {
    PARALLAX: '1',
    PARALLAX_ENTRY_ID: options.entryId ?? 'spike',
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: options.clientApp ?? 'parallax/0.0.0-spike',
    ...options.extra,
  };
  for (const [key, value] of Object.entries(set)) {
    setCaseInsensitive(env, key, value);
  }

  removed.sort((a, b) => a.localeCompare(b));
  return { env, removed, pathEntriesRemoved, set };
}
