/**
 * Test double of the `ConsoleLauncher` port (Phase 2, WP-34, ADR-104): opens nothing, hands out
 * PIDs from 60 000 with the harness clock as start time, records every spec and every `state()`
 * check, answers `state()` per PID as the test sets it (default `running`) and fails the next
 * `open()` on request. `onOpen` runs synchronously inside `open()` (e.g. a simulated console turn).
 * Only tests import this (the fake server uses `system/fakeConsole.ts`).
 */
import type { ConsoleLaunchSpec } from '../../claude/ports';
import type { ConsoleLauncher, ConsoleProcess } from '../../system/ports';

export type TestConsoleState = 'running' | 'ended' | 'unknown';

export interface TestConsoleLauncher extends ConsoleLauncher {
  /** Every spec passed to open() (also the failed ones). */
  readonly opened: readonly ConsoleLaunchSpec[];
  /** Every process passed to state(). */
  readonly checks: readonly ConsoleProcess[];
  /** state() of this PID from now on (null PID = processes without one). */
  setState(pid: number | null, state: TestConsoleState): void;
  /** The next open() answers `{kind:'failed', reason}`. */
  failNext(reason: string): void;
  /** The next open() reports a process without PID/start time. */
  unknownNext(): void;
}

export const TEST_CONSOLE_FIRST_PID = 60_000;

export function createTestConsoleLauncher(o: {
  now: () => Date;
  onOpen?: (spec: ConsoleLaunchSpec) => void;
}): TestConsoleLauncher {
  const opened: ConsoleLaunchSpec[] = [];
  const checks: ConsoleProcess[] = [];
  const states = new Map<number | null, TestConsoleState>();
  let nextPid = TEST_CONSOLE_FIRST_PID;
  let failure: string | null = null;
  let unknown = false;
  return {
    opened,
    checks,
    setState(pid, state) {
      states.set(pid, state);
    },
    failNext(reason) {
      failure = reason;
    },
    unknownNext() {
      unknown = true;
    },
    open(spec) {
      opened.push(spec);
      if (failure !== null) {
        const reason = failure;
        failure = null;
        return Promise.resolve({ kind: 'failed', reason });
      }
      o.onOpen?.(spec);
      if (unknown) {
        unknown = false;
        return Promise.resolve({ kind: 'opened', process: { pid: null, startedAt: null } });
      }
      const pid = nextPid;
      nextPid += 1;
      return Promise.resolve({ kind: 'opened', process: { pid, startedAt: o.now() } });
    },
    state(process) {
      checks.push(process);
      return Promise.resolve(states.get(process.pid) ?? 'running');
    },
  };
}
