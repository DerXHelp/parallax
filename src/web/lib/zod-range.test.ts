import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { idleSleepSchema, portSettingSchema, profileInputSchema } from '@shared/model';
import { numberRange } from './zod-range';

describe('numberRange', () => {
  it('reads min and max of a number schema', () => {
    expect(numberRange(z.number().min(5).max(1440))).toEqual({ min: 5, max: 1440 });
    expect(numberRange(idleSleepSchema.shape.minutes)).toEqual({ min: 5, max: 1440 });
    expect(numberRange(portSettingSchema.unwrap())).toEqual({ min: 1024, max: 65535 });
    expect(numberRange(profileInputSchema.shape.contextWindow.unwrap())).toEqual({
      min: 100_000,
      max: 1_000_000,
    });
  });

  it('is unbounded without min/max', () => {
    expect(numberRange(z.number())).toEqual({ min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY });
    expect(numberRange(z.number().min(0))).toEqual({ min: 0, max: Number.POSITIVE_INFINITY });
  });
});
