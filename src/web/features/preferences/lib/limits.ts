import type { ZodNumber } from 'zod';
import { idleSleepSchema, notificationSettingsPatchSchema, portSettingSchema } from '@shared/model';

/** Allowed range of a number setting – read from the contract, never duplicated (WP-30 §4.5). */
export interface NumberRange {
  min: number;
  max: number;
}

function rangeOf(schema: ZodNumber): NumberRange {
  return { min: schema.minValue ?? 0, max: schema.maxValue ?? Number.MAX_SAFE_INTEGER };
}

/** `settings.idleSleep.minutes` (ADR-105: 5–1440). */
export const IDLE_MINUTES = rangeOf(idleSleepSchema.shape.minutes);
/** `settings.notifications.doneMinSeconds` (0–600). */
export const DONE_SECONDS = rangeOf(notificationSettingsPatchSchema.shape.doneMinSeconds);
/** `settings.port` (ADR-111: 1024–65535, null = default). */
export const PORT_RANGE = rangeOf(portSettingSchema.unwrap());
/** The server's default port when `settings.port` is null (src/server/config.ts, ADR-111). */
export const DEFAULT_PORT = 4711;

/**
 * A whole number typed by the user: digits only (no sign, no decimals, no exponent), within the
 * range; `null` for an empty field when allowed; `undefined` = invalid.
 */
export function parseWholeNumber(
  raw: string,
  range: NumberRange,
  allowEmpty: boolean,
): number | null | undefined {
  const text = raw.trim();
  if (text === '') return allowEmpty ? null : undefined;
  if (!/^\d{1,9}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= range.min && value <= range.max ? value : undefined;
}
