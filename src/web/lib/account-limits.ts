import type { RateLimitInfo } from '@shared/model';

/**
 * Subscription limits for the display at the bottom of the sidebar (Plan "Abo-Limit-Anzeige", F.13):
 * the 5-hour and the weekly window from `unifiedWindows` (`RateLimitInfo.windows`), otherwise the
 * window of the event itself (`rateLimitType` + `utilization`). `utilization` is a fraction (0–1).
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

/** The bars to show for one profile: known windows in a fixed order; empty when nothing is known. */
export function limitBars(info: RateLimitInfo): LimitBar[] {
  const bars: LimitBar[] = [];
  for (const window of LIMIT_WINDOWS) {
    const value = info.windows[window];
    if (value?.utilization === null || value?.utilization === undefined) continue;
    bars.push({ window, percent: toPercent(value.utilization), resetsAt: value.resetsAt });
  }
  if (bars.length > 0) return bars;
  if (info.utilization === null) return [];
  return [
    {
      window: info.rateLimitType ?? 'unknown',
      percent: toPercent(info.utilization),
      resetsAt: info.resetsAt,
    },
  ];
}
