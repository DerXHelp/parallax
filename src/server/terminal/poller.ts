/**
 * Output poller of the embedded terminal (WP-99, values confirmed by the WP-98 spike): ONE shared
 * timer for every terminal of this computer, unref'd (it never keeps the process alive).
 *
 * - Cadence: 16 ms after a tick that read data (or while a shell is ending), otherwise 100 ms;
 *   `wake()` pulls an idle tick forward to 16 ms (input → echo without a noticeable lag).
 * - Reading only through the non-blocking `read(max)`: at most `POLL_TERMINAL_BYTES` per terminal
 *   and `POLL_TICK_BYTES` per tick. The start rotates every tick (round robin), so a flood in one
 *   terminal cannot starve the others.
 * - All reads of one terminal in a tick are concatenated and handed over ONCE (`output`), so a
 *   socket gets at most one frame per terminal per tick.
 * - Every tick also runs `beforeTick` (backpressure of the sockets) and `checkExits` – so exits are
 *   noticed at least every `POLL_IDLE_MS` (≤ 250 ms).
 * - The timer stops while `active()` is false (no running terminal) and starts again on `wake()`.
 *
 * The poller knows nothing about terminals: `service.ts` passes the hooks.
 */
import { realTimers, type TimerHandle, type Timers } from '../sessions/lib/timers';

export const POLL_ACTIVE_MS = 16;
export const POLL_IDLE_MS = 100;
/** Most bytes read from one terminal in one tick. */
export const POLL_TERMINAL_BYTES = 64 * 1024;
/** Most bytes read from all terminals together in one tick. */
export const POLL_TICK_BYTES = 256 * 1024;

export interface PollerHooks<T> {
  /** First thing of every tick (the service checks the sockets' backpressure here). */
  beforeTick(now: number): void;
  /** The terminals to read in this tick, in a stable order (paused ones left out). */
  readable(): readonly T[];
  /** Non-blocking read of at most `max` bytes; null = nothing waiting. */
  read(source: T, max: number): Uint8Array | null;
  /** Everything read from `source` in this tick (at most once per source per tick). */
  output(source: T, data: Uint8Array): void;
  /** Exit check of the running terminals; true = keep ticking fast (a shell is ending). */
  checkExits(now: number): boolean;
  /** False when nothing is left to poll: the timer stops until `wake()`. */
  active(): boolean;
}

export interface PollerOptions {
  timers?: Timers;
  now?: () => number;
  /** Errors thrown by a hook (the tick goes on with the next terminal). */
  onError?: (error: unknown) => void;
}

export interface Poller {
  /** Makes sure a tick comes within `POLL_ACTIVE_MS` (also starts a stopped poller). */
  wake(): void;
  /** Runs one tick now (and schedules the next one). */
  tick(): void;
  /** Stops the timer; `wake()` starts it again. */
  stop(): void;
  /** True while a tick is scheduled. */
  readonly running: boolean;
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const only = parts[0];
  if (parts.length === 1 && only !== undefined) return only;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createPoller<T>(hooks: PollerHooks<T>, options: PollerOptions = {}): Poller {
  const timers = options.timers ?? realTimers;
  const now = options.now ?? Date.now;
  const onError = options.onError ?? (() => undefined);
  let timer: TimerHandle | null = null;
  let dueAt = 0;
  /** Round-robin start of the next tick. */
  let cursor = 0;

  const guard = <R>(work: () => R, fallback: R): R => {
    try {
      return work();
    } catch (error) {
      onError(error);
      return fallback;
    }
  };

  const schedule = (ms: number): void => {
    if (timer !== null) {
      if (dueAt <= now() + ms) return;
      timer.cancel();
    }
    dueAt = now() + ms;
    timer = timers.setTimeout(() => {
      timer = null;
      tick();
    }, ms);
  };

  /** Reads one source up to its budget; returns the bytes read. */
  const readSource = (source: T, budget: number): number => {
    const parts: Uint8Array[] = [];
    let total = 0;
    const limit = Math.min(POLL_TERMINAL_BYTES, budget);
    while (total < limit) {
      const chunk = guard(() => hooks.read(source, limit - total), null);
      if (chunk === null || chunk.length === 0) break;
      parts.push(chunk);
      total += chunk.length;
    }
    if (total > 0) {
      const data = concat(parts, total);
      guard(() => {
        hooks.output(source, data);
      }, undefined);
    }
    return total;
  };

  function tick(): void {
    if (timer !== null) {
      timer.cancel();
      timer = null;
    }
    const at = now();
    guard(() => {
      hooks.beforeTick(at);
    }, undefined);
    const sources = guard(() => hooks.readable(), []);
    let budget = POLL_TICK_BYTES;
    let readAny = false;
    const count = sources.length;
    if (count > 0) {
      const start = cursor % count;
      cursor = (start + 1) % count;
      for (let i = 0; i < count && budget > 0; i += 1) {
        const source = sources[(start + i) % count];
        if (source === undefined) continue;
        const got = readSource(source, budget);
        budget -= got;
        if (got > 0) readAny = true;
      }
    }
    const ending = guard(() => hooks.checkExits(now()), false);
    if (!guard(() => hooks.active(), false)) return;
    schedule(readAny || ending ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  return {
    wake() {
      schedule(POLL_ACTIVE_MS);
    },
    tick,
    stop() {
      timer?.cancel();
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
