/**
 * Rate-limit windows the SDK names in `RateLimitInfo.rateLimitType` (an open set). The known ones
 * get a translated label in the transcript (V3-13: no raw "five_hour"); others are shown as sent.
 */
export const RATE_LIMIT_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
] as const;

export type RateLimitWindow = (typeof RATE_LIMIT_WINDOWS)[number];

export function isKnownRateLimitWindow(value: string): value is RateLimitWindow {
  return (RATE_LIMIT_WINDOWS as readonly string[]).includes(value);
}
