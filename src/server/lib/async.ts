/**
 * Small async helpers of the server (R2-10: one place instead of copies in backend/, sessions/,
 * launcher/ and store/). No I/O, no logging.
 */

/**
 * The real `setImmediate`, captured when this module is first imported – before a test can install
 * Vitest fake timers. Code that must make progress under fake timers (FakeBackend playback, the
 * manual engine clock, test pollers) schedules through this.
 */
export const realSetImmediate: typeof setImmediate = setImmediate;

/** Resolves on the next real macrotask (unaffected by fake timers, see `realSetImmediate`). */
export function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    realSetImmediate(resolve);
  });
}

/** Resolves after `ms` (the global `setTimeout`, so fake timers apply). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** A thrown value as an `Error` (non-errors are wrapped with `String(value)` as message). */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type Settled = { outcome: 'done' } | { outcome: 'failed'; error: unknown } | { outcome: 'timeout' };

/**
 * Runs `work` (sync or async) and settles within `ms` – never rejects, the timer is cleared as soon
 * as `work` settles (R3-10: one helper for the bounded cleanup/shutdown steps). A `work` that is
 * still running after the timeout keeps running; its later result is ignored.
 */
export function settleWithin(work: () => unknown, ms: number): Promise<Settled> {
  return new Promise<Settled>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ outcome: 'timeout' });
    }, ms);
    Promise.resolve()
      .then(work)
      .then(
        () => {
          clearTimeout(timer);
          resolve({ outcome: 'done' });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ outcome: 'failed', error });
        },
      );
  });
}
