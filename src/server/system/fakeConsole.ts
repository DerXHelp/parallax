/**
 * Fake console (`--backend=fake`, E2E, engine tests; WP-34/WP-40): opens nothing. `open` hands
 * out a synthetic PID (≥ 50 000, counting up) with the current time and reports the spec to
 * `onRun`; `state` is `running` until `runMs` (default 1.5 s) after that start, then `ended` – so
 * the engine's automatic return (ADR-104) runs end to end without a real console. A process
 * without a start time is `ended` (nothing of the fake survives a server restart).
 */
import type { ConsoleLaunchSpec } from '../claude/ports';
import type { ConsoleLauncher } from './ports';

export const FAKE_CONSOLE_RUN_MS = 1_500;
export const FAKE_CONSOLE_FIRST_PID = 50_000;

export interface FakeConsoleLauncherOptions {
  runMs?: number;
  /** Called with every opened spec (tests, E2E log); errors are swallowed. */
  onRun?: (spec: ConsoleLaunchSpec) => void;
  now?: () => Date;
}

export function createFakeConsoleLauncher(opts: FakeConsoleLauncherOptions = {}): ConsoleLauncher {
  const runMs = opts.runMs ?? FAKE_CONSOLE_RUN_MS;
  const now = opts.now ?? (() => new Date());
  let nextPid = FAKE_CONSOLE_FIRST_PID;
  return {
    open: (spec) => {
      const pid = nextPid;
      nextPid += 1;
      const startedAt = now();
      try {
        opts.onRun?.(spec);
      } catch {
        // a test hook must not fail the open
      }
      return Promise.resolve({ kind: 'opened', process: { pid, startedAt } });
    },
    state: (proc) => {
      if (proc.startedAt === null) return Promise.resolve('ended');
      return Promise.resolve(now().getTime() - proc.startedAt.getTime() < runMs ? 'running' : 'ended');
    },
  };
}
