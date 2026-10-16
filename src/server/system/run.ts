/**
 * Shared bits of the Windows integration and the R6 guard (WP-30 §9: "Systemintegration aus
 * Tests/Dev auf echtes HKCU/Autostart"): a test run (Vitest, or an E2E server with `NODE_ENV=test`)
 * never reaches the real `runFile` or the real environment through this folder. A test must inject
 * `run` and `env` (temp `APPDATA`); without them every call is refused before anything is spawned
 * – the console, the shortcut and the registry stay untouched even by a forgotten seam.
 */
import { runFile, type RunFileFn } from '../lib/process';

/** Result of one integration step; never thrown (failures become host warnings). */
export type SystemOpResult = { ok: true } | { ok: false; reason: string };

/** Vitest or an E2E server (`NODE_ENV=test`) – checked on every call. */
export function isTestProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST !== undefined || env.NODE_ENV === 'test';
}

export const TEST_RUN_REFUSAL = 'refused in a test run - inject run/env';

/** The injected runner, else `runFile` – which a test run never gets (rejects, nothing spawned). */
export function systemRunner(run?: RunFileFn): RunFileFn {
  if (run !== undefined) return run;
  return (file, args, options) =>
    isTestProcess() ? Promise.reject(new Error(TEST_RUN_REFUSAL)) : runFile(file, args, options);
}

/** The injected environment, else `process.env` – in a test run an empty one (no real APPDATA). */
export function systemEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env !== undefined) return env;
  return isTestProcess() ? {} : process.env;
}
