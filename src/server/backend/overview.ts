/**
 * WP-65 (overview): the SDK boundary of `query.generateSessionTitle` (internal in SDK 0.3.322) and
 * of the experimental usage query (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`).
 * Pure helpers: tolerant parsing of both answers (zod). Used by SdkBackend, the FakeBackend and the
 * cli-check probe.
 */
import { z } from 'zod';
import type { UsageLimits, UsageWindow } from './types';

/** Longest title taken over (the registry caps titles at LIMITS.titleChars = 200). */
const TITLE_CHARS = 200;

/** `generateSessionTitle` answers the title string (the SDK unwraps `response.title`). */
export const titleAnswerSchema = z.string().max(2000).nullable();

/** The answer as a usable title: whitespace collapsed, ≤ 200 chars; empty / not a string → null. */
export function titleOf(raw: unknown): string | null {
  const parsed = titleAnswerSchema.safeParse(raw);
  if (!parsed.success || parsed.data === null) return null;
  const title = parsed.data.replace(/\s+/g, ' ').trim();
  return title === '' ? null : title.slice(0, TITLE_CHARS);
}

const usageWindowSchema = z.looseObject({
  utilization: z.number().nullable().optional(),
  resets_at: z.string().max(100).nullable().optional(),
});

const extraUsageSchema = z.looseObject({
  is_enabled: z.boolean().optional(),
  utilization: z.number().nullable().optional(),
});

/**
 * The part of the answer Parallax reads: `rate_limits` (an object of windows; each window an object
 * with `utilization` 0–100 and `resets_at`, or null). Everything else (session cost, line counts,
 * behaviors, codename windows) is ignored.
 */
export const usageAnswerSchema = z.looseObject({
  rate_limits_available: z.boolean().optional(),
  rate_limits: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Windows the display knows (`five_hour`, `seven_day` …): an explicit null clears a stored value. */
export const KNOWN_USAGE_WINDOWS: readonly string[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
];

/** `extra_usage` of the usage answer is the window `overage` of the rate-limit events. */
const EXTRA_USAGE = 'extra_usage';
const OVERAGE = 'overage';

function isoOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 0–100 (usage query) → 0–1 (the unit of `RateLimitInfo`, WP-65); out of range is clamped. */
function fraction(percent: number): number {
  return Math.min(1, Math.max(0, percent / 100));
}

/**
 * The usage answer → plan limits, or null when the shape is unknown or plan limits do not apply
 * (`rate_limits_available: false`, `rate_limits: null` – API key, Bedrock …). Windows with a value
 * only; `cleared` lists the known windows the answer reports as null.
 */
export function usageLimitsOf(raw: unknown): UsageLimits | null {
  const parsed = usageAnswerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const limits = parsed.data.rate_limits;
  if (parsed.data.rate_limits_available === false || limits === null || limits === undefined) return null;
  const windows: Record<string, UsageWindow> = {};
  const cleared: string[] = [];
  for (const [key, value] of Object.entries(limits)) {
    if (key === EXTRA_USAGE) {
      const extra = extraUsageSchema.safeParse(value);
      if (!extra.success || value === null) continue;
      const utilization = extra.data.utilization;
      if (extra.data.is_enabled === true && typeof utilization === 'number' && Number.isFinite(utilization)) {
        windows[OVERAGE] = { utilization: fraction(utilization), resetsAt: null };
      } else {
        cleared.push(OVERAGE);
      }
      continue;
    }
    if (value === null) {
      if (KNOWN_USAGE_WINDOWS.includes(key)) cleared.push(key);
      continue;
    }
    const window = usageWindowSchema.safeParse(value);
    if (!window.success) continue;
    const utilization = window.data.utilization;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
      if (KNOWN_USAGE_WINDOWS.includes(key)) cleared.push(key);
      continue;
    }
    windows[key] = { utilization: fraction(utilization), resetsAt: isoOrNull(window.data.resets_at) };
  }
  return { windows, cleared };
}
