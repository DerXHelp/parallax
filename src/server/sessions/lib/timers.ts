/**
 * Timer seam of the session engine (WP-13 §2.3 Nr. 8): every delay of the manager (auto-retry
 * backoff, context refresh, host-state debounce, shutdown cap, sleep policy) goes through
 * `Timers`, so tests run without wall-clock dependence. `realTimers` wraps `setTimeout` (unref'd –
 * an engine timer never keeps the process alive); `createManualTimers()` is a virtual clock for
 * tests: zero-delay timers fire on the next real macrotask, longer ones only on `advance()`.
 */

/** Captured at import time: Vitest fake timers never stop the manual clock's zero-delay path. */
const realSetImmediate = setImmediate;

export interface TimerHandle {
  /** Idempotent; a fired timer ignores it. */
  cancel(): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
}

export const realTimers: Timers = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, Math.max(0, ms));
    timer.unref();
    return {
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },
};

export interface ManualTimer {
  readonly id: number;
  readonly ms: number;
  /** Virtual time at which it fires. */
  readonly dueAt: number;
}

export interface ManualTimers extends Timers {
  /** Pending timers with a delay > 0 (zero-delay ones fire on their own), by due time. */
  pending(): ManualTimer[];
  /** Virtual milliseconds elapsed so far. */
  elapsed(): number;
  /** Moves the virtual clock forward and fires every timer that became due, in due order. */
  advance(ms: number): void;
  /** Fires the earliest pending timer (moving the clock to it); false if none is pending. */
  runNext(): boolean;
}

interface Entry extends ManualTimer {
  callback: () => void;
  cancelled: boolean;
}

export function createManualTimers(): ManualTimers {
  let clock = 0;
  let counter = 0;
  const entries: Entry[] = [];

  const due = (): Entry[] =>
    entries.filter((e) => !e.cancelled).sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);

  const fire = (entry: Entry): void => {
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.callback();
  };

  return {
    setTimeout(callback, ms) {
      counter += 1;
      const delay = Math.max(0, ms);
      const entry: Entry = { id: counter, ms: delay, dueAt: clock + delay, callback, cancelled: false };
      if (delay === 0) {
        realSetImmediate(() => {
          if (!entry.cancelled) {
            entry.cancelled = true;
            callback();
          }
        });
      } else {
        entries.push(entry);
      }
      return {
        cancel: () => {
          entry.cancelled = true;
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
        },
      };
    },
    pending: () => due().map(({ id, ms, dueAt }) => ({ id, ms, dueAt })),
    elapsed: () => clock,
    advance(ms) {
      const target = clock + Math.max(0, ms);
      for (;;) {
        const next = due()[0];
        if (next === undefined || next.dueAt > target) break;
        clock = Math.max(clock, next.dueAt);
        fire(next);
      }
      clock = target;
    },
    runNext() {
      const next = due()[0];
      if (next === undefined) return false;
      clock = Math.max(clock, next.dueAt);
      fire(next);
      return true;
    },
  };
}
