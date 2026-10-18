import type { ZodNumber } from 'zod';

/** Allowed range of a number field. */
export interface NumberRange {
  min: number;
  max: number;
}

/**
 * The range of a zod number schema (`.min()`/`.max()`, also from `.int()`): read from the contract,
 * never duplicated as literals (WP-30 §4.5, R4W-21). Without a bound: ±Infinity.
 */
export function numberRange(schema: ZodNumber): NumberRange {
  return {
    min: schema.minValue ?? Number.NEGATIVE_INFINITY,
    max: schema.maxValue ?? Number.POSITIVE_INFINITY,
  };
}
