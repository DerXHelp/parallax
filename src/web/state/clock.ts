import { useCallback, useMemo, useSyncExternalStore } from 'react';

/**
 * One shared clock for time-dependent UI (relative times, `deriveDisplayStatus` with
 * `rateLimitedUntil`/`wakeupAt`). Components never call `Date.now()` while rendering; they read
 * this clock, which ticks only while someone needs it:
 * - `useNow(intervalMs)`: re-render at least every `intervalMs`.
 * - `useNowUntil(deadlines)`: re-render only when one of the deadlines passes.
 */

let now = Date.now();
const listeners = new Set<() => void>();
const intervalRequests = new Map<symbol, number>();
const deadlineRequests = new Map<symbol, readonly number[]>();
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let intervalMs: number | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

function tick(): void {
  now = Date.now();
  for (const listener of [...listeners]) listener();
  scheduleDeadline();
}

function scheduleInterval(): void {
  const wanted = intervalRequests.size === 0 ? null : Math.min(...intervalRequests.values());
  if (wanted === intervalMs) return;
  if (intervalTimer !== null) clearInterval(intervalTimer);
  intervalTimer = null;
  intervalMs = wanted;
  if (wanted !== null) intervalTimer = setInterval(tick, wanted);
}

function scheduleDeadline(): void {
  if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  deadlineTimer = null;
  const current = Date.now();
  let next = Number.POSITIVE_INFINITY;
  for (const deadlines of deadlineRequests.values()) {
    for (const deadline of deadlines) {
      // Deadlines the clock has not passed yet (also if the real time already did).
      if (deadline > now && deadline < next) next = deadline;
    }
  }
  if (next === Number.POSITIVE_INFINITY) return;
  deadlineTimer = setTimeout(tick, Math.max(0, next - current) + 5);
}

/** Current clock value (epoch ms); stable between ticks. */
export function getClockNow(): number {
  return now;
}

/** Advances the clock to the real time and notifies (tests after `vi.setSystemTime`). */
export function refreshClock(): void {
  tick();
}

function subscribeClock(
  listener: () => void,
  id: symbol,
  request: { intervalMs?: number; deadlines?: readonly number[] },
) {
  listeners.add(listener);
  if (request.intervalMs !== undefined) intervalRequests.set(id, request.intervalMs);
  if (request.deadlines !== undefined) deadlineRequests.set(id, request.deadlines);
  scheduleInterval();
  scheduleDeadline();
  // A component mounted after a quiet period starts with a fresh time.
  if (Date.now() - now >= 1000) tick();
  return () => {
    listeners.delete(listener);
    intervalRequests.delete(id);
    deadlineRequests.delete(id);
    scheduleInterval();
    scheduleDeadline();
  };
}

/** Epoch ms, updated at least every `intervalMs` while mounted. */
export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback(
    (listener: () => void) => subscribeClock(listener, Symbol('useNow'), { intervalMs }),
    [intervalMs],
  );
  return useSyncExternalStore(subscribe, getClockNow, getClockNow);
}

function toEpoch(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Epoch ms; re-renders ONLY when one of the (ISO or epoch) deadlines passes – not on the ticks of
 * other `useNow` users (R1W-10). The value is the shared clock at render time.
 */
export function useNowUntil(deadlines: readonly (string | number | null | undefined)[]): number {
  const key = deadlines.map((deadline) => String(toEpoch(deadline))).join('|');
  const epochs = useMemo(
    () =>
      key
        .split('|')
        .map(Number)
        .filter((value) => Number.isFinite(value)),
    [key],
  );
  const subscribe = useCallback(
    (listener: () => void) => subscribeClock(listener, Symbol('useNowUntil'), { deadlines: epochs }),
    [epochs],
  );
  // Snapshot = number of passed deadlines: it changes only when a deadline passes.
  const passedDeadlines = useCallback(() => epochs.filter((deadline) => deadline <= now).length, [epochs]);
  useSyncExternalStore(subscribe, passedDeadlines, passedDeadlines);
  return getClockNow();
}
