/**
 * Shared bits of the Windows integration and the R6 guard (WP-30 §9: "Systemintegration aus
 * Tests/Dev auf echtes HKCU/Autostart"): a test run (Vitest, or an E2E server with `NODE_ENV=test`)
 * never reaches the real `runFile` or the real environment through this folder. A test must inject
 * `run` and `env` (temp `APPDATA`); without them every call is refused before anything is spawned
 * – the console, the shortcut and the registry stay untouched even by a forgotten seam.
 */
import { isTestRun } from '../config';
import { runFile, spawnHidden, type RunFileFn, type SpawnHiddenOptions } from '../lib/process';

/**
 * Result of one integration step; never thrown (failures become host warnings). `deferred`: the
 * entry belongs to an installation and a clone left it alone (system/markers.ts) – no failure.
 */
export type SystemOpResult = { ok: true; deferred?: true } | { ok: false; reason: string };

/**
 * Vitest or an E2E server (`NODE_ENV=test`) – checked on every call; the one rule of config.ts
 * (`isTestRun`, R4-14: under Vitest also with a hand-made `env`).
 */
export const isTestProcess = isTestRun;

export const TEST_RUN_REFUSAL = 'refused in a test run - inject run/env';

/** The injected runner, else `runFile` – which a test run never gets (rejects, nothing spawned). */
export function systemRunner(run?: RunFileFn): RunFileFn {
  if (run !== undefined) return run;
  return (file, args, options) =>
    isTestProcess() ? Promise.reject(new Error(TEST_RUN_REFUSAL)) : runFile(file, args, options);
}

/** What the Linux console needs of a started terminal emulator (a ChildProcess; fakes in tests). */
export interface SpawnedProcess {
  readonly pid?: number | undefined;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  unref(): void;
}

export type SystemSpawnFn = (
  file: string,
  args: readonly string[],
  options: SpawnHiddenOptions,
) => SpawnedProcess;

/**
 * WP-106: the injected spawner, else `spawnHidden` – which a test run never gets (throws before
 * anything starts, like `systemRunner`). The Linux console opens a terminal emulator with it.
 */
export function systemSpawner(spawn?: SystemSpawnFn): SystemSpawnFn {
  if (spawn !== undefined) return spawn;
  return (file, args, options) => {
    if (isTestProcess()) throw new Error(TEST_RUN_REFUSAL);
    return spawnHidden(file, args, options);
  };
}

/** The injected environment, else `process.env` – in a test run an empty one (no real APPDATA). */
export function systemEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env !== undefined) return env;
  return isTestProcess() ? {} : process.env;
}
