/**
 * Environment of the live `claude` runs of the fixture recorder (WP-01).
 *
 * Uses the real builder `buildEnvReport()` (src/server/claude/env.ts, WP-11) with the built-in
 * profile "Standard" and only adds the spike extras: the recorder must use the subscription login,
 * so `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL` are removed, as is the
 * recorder's own guard flag `PARALLAX_LIVE`; PARALLAX_ENTRY_ID is `spike` (not an entry id).
 */
import { buildEnvReport, setEnvVar } from '../../src/server/claude/env';
import { STANDARD_PROFILE } from '../../src/server/claude/profiles';

/** Spike only: removed by exact (upper-cased) name before the real builder runs. */
const SPIKE_REMOVE: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'PARALLAX_LIVE',
]);

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

/** Builds the environment for one spike `claude` process from `base` (usually `process.env`). */
export function buildSpikeEnv(base: NodeJS.ProcessEnv, options: SpikeEnvOptions = {}): SpikeEnvResult {
  const filtered: Record<string, string | undefined> = {};
  const spikeRemoved: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    if (SPIKE_REMOVE.has(key.toUpperCase())) spikeRemoved.push(key);
    else filtered[key] = value;
  }

  const report = buildEnvReport({
    base: filtered,
    profile: STANDARD_PROFILE,
    entryId: null,
    clientApp: options.clientApp ?? 'parallax/0.0.0-spike',
    ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
  });
  const first = report.issues[0];
  if (first !== undefined) throw new Error(`buildEnv: ${first.code} ${JSON.stringify(first.params)}`);

  const set: Record<string, string> = {
    ...report.set,
    PARALLAX_ENTRY_ID: options.entryId ?? 'spike',
    ...options.extra,
  };
  for (const [key, value] of Object.entries(set)) setEnvVar(report.env, key, value);

  const removed = [...report.removed, ...spikeRemoved].sort((a, b) => a.localeCompare(b));
  return { env: report.env, removed, pathEntriesRemoved: report.pathEntriesRemoved, set };
}
