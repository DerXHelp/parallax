import { idleSleepSchema, notificationSettingsPatchSchema, portSettingSchema } from '@shared/model';
import { numberRange, type NumberRange } from '@web/lib/zod-range';

/** Ranges of the number settings – read from the contract, never duplicated (WP-30 §4.5). */
export type { NumberRange };

/** `settings.idleSleep.minutes` (ADR-105: 5–1440). */
export const IDLE_MINUTES = numberRange(idleSleepSchema.shape.minutes);
/** `settings.notifications.doneMinSeconds` (0–600). */
export const DONE_SECONDS = numberRange(notificationSettingsPatchSchema.shape.doneMinSeconds);
/** `settings.port` (ADR-111: 1024–65535, null = default `DEFAULT_PORT` from `@shared/model`). */
export const PORT_RANGE = numberRange(portSettingSchema.unwrap());

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
