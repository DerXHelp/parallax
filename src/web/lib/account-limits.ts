import type { RateLimitInfo } from '@shared/model';

/**
 * Subscription limits for the display at the bottom of the sidebar (Plan "Abo-Limit-Anzeige", F.13):
 * the 5-hour and the weekly window from `unifiedWindows` (`RateLimitInfo.windows`) plus the window
 * of the event itself (`rateLimitType` + `utilization`) when it is another one (WP-63 §1.2: weekly
 * Opus/Sonnet, extra usage … – their warnings no longer show in the transcript). `utilization` is a
 * fraction (0–1). Windows whose reset has passed are left out (R4W-06): the stored value is history.
 */
export const LIMIT_WINDOWS = ['five_hour', 'seven_day'] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

/** Windows with a translated label (`navigation.limits.windows`); others are shown by name. */
export const LABELED_LIMIT_WINDOWS = [
  ...LIMIT_WINDOWS,
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
] as const;
export type LabeledLimitWindow = (typeof LABELED_LIMIT_WINDOWS)[number];

export interface LimitBar {
  /** `five_hour`, `seven_day` or another window name of the SDK (open set). */
  window: string;
  /** 0–100. */
  percent: number;
  resetsAt: string | null;
}

function toPercent(utilization: number): number {
  return Math.min(100, Math.max(0, utilization * 100));
}

export function isKnownLimitWindow(window: string): window is LabeledLimitWindow {
  return (LABELED_LIMIT_WINDOWS as readonly string[]).includes(window);
}

/**
 * A window whose reset lies at or before `now` (epoch ms): its utilization is history – the
 * value is kept (ADR-114) until the next `rate_limit_event` replaces it (R4W-06, V3-07).
 */
function expired(resetsAt: string | null, now: number): boolean {
  if (resetsAt === null) return false;
  const at = Date.parse(resetsAt);
  return Number.isFinite(at) && at <= now;
}

/**
 * The bars to show for one profile at `now` (epoch ms): the 5-hour and the weekly window in a fixed
 * order, then the window of the event when it is none of them (WP-63 §1.2) – windows already reset
 * left out; empty when nothing (current) is known. Every event replaces the stored info (ADR-114),
 * so each new value shows at once.
 */
export function limitBars(info: RateLimitInfo, now: number): LimitBar[] {
  const bars: LimitBar[] = [];
  const known = new Set<string>();
  for (const window of LIMIT_WINDOWS) {
    const value = info.windows[window];
    if (value?.utilization === null || value?.utilization === undefined) continue;
    known.add(window);
    if (expired(value.resetsAt, now)) continue;
    bars.push({ window, percent: toPercent(value.utilization), resetsAt: value.resetsAt });
  }
  // Without a window name the event only stands for itself when no window is known.
  const own = info.rateLimitType ?? (known.size === 0 ? 'unknown' : null);
  if (own === null || known.has(own) || info.utilization === null || expired(info.resetsAt, now)) return bars;
  bars.push({ window: own, percent: toPercent(info.utilization), resetsAt: info.resetsAt });
  return bars;
}

/**
 * The moments at which the bars of `infos` change by time alone: each future reset, and the
 * point a day before it (the text turns from "on <date>" into "at <time>").
 */
export function limitDeadlines(infos: readonly RateLimitInfo[], dayMs: number): number[] {
  const result: number[] = [];
  for (const info of infos) {
    for (const resetsAt of [...Object.values(info.windows).map((value) => value.resetsAt), info.resetsAt]) {
      if (resetsAt === null) continue;
      const at = Date.parse(resetsAt);
      if (Number.isFinite(at)) result.push(at, at - dayMs);
    }
  }
  return result;
}
