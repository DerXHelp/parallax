import type { RateLimitInfo } from '@shared/model';

/**
 * Subscription limits for the display at the bottom of the sidebar (Plan "Abo-Limit-Anzeige", F.13):
 * the 5-hour and the weekly window from `unifiedWindows` (`RateLimitInfo.windows`), otherwise the
 * window of the event itself (`rateLimitType` + `utilization`). `utilization` is a fraction (0–1).
 * Windows whose reset has passed are left out (R4W-06): the stored value is history.
 */
export const LIMIT_WINDOWS = ['five_hour', 'seven_day'] as const;
export type LimitWindow = (typeof LIMIT_WINDOWS)[number];

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

export function isKnownLimitWindow(window: string): window is LimitWindow {
  return (LIMIT_WINDOWS as readonly string[]).includes(window);
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
 * The bars to show for one profile at `now` (epoch ms): known windows in a fixed order, windows
 * already reset left out; empty when nothing (current) is known.
 */
export function limitBars(info: RateLimitInfo, now: number): LimitBar[] {
  const bars: LimitBar[] = [];
  let known = false;
  for (const window of LIMIT_WINDOWS) {
    const value = info.windows[window];
    if (value?.utilization === null || value?.utilization === undefined) continue;
    known = true;
    if (expired(value.resetsAt, now)) continue;
    bars.push({ window, percent: toPercent(value.utilization), resetsAt: value.resetsAt });
  }
  if (known) return bars;
  if (info.utilization === null || expired(info.resetsAt, now)) return [];
  return [
    {
      window: info.rateLimitType ?? 'unknown',
      percent: toPercent(info.utilization),
      resetsAt: info.resetsAt,
    },
  ];
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
