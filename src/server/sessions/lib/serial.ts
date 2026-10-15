/**
 * Serial execution per entry – the lifecycle lock of WP-13 §3.5.2: start, close, resume, rename
 * (dormant) and auto-retry of one entry run strictly one after another (never two writers on one
 * Claude JSONL, "SDK and PTY never at the same time" for the Phase-2 handoff). A failing task does
 * not block the following ones.
 */
export interface Serial {
  /** Runs `task` after every task queued before it has settled. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks queued or running. */
  readonly pending: number;
  /** Resolves once every task queued so far has settled. */
  idle(): Promise<void>;
}

export function createSerial(): Serial {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  const done = (): void => {
    pending -= 1;
  };
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      const result = tail.then(task);
      tail = result.then(done, done);
      return result;
    },
    get pending() {
      return pending;
    },
    idle: () => tail,
  };
}
