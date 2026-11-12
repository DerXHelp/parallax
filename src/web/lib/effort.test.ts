import { describe, expect, it } from 'vitest';
import { effectiveEffort } from './effort';

describe('effectiveEffort (WP-63 §1.1)', () => {
  it('own value, then the reported CLI default, then the profile default, else nothing', () => {
    expect(effectiveEffort({ effort: 'low', initEffort: 'high', profileEffort: 'max' })).toBe('low');
    expect(effectiveEffort({ effort: null, initEffort: 'high', profileEffort: 'max' })).toBe('high');
    expect(effectiveEffort({ effort: null, initEffort: null, profileEffort: 'max' })).toBe('max');
    expect(effectiveEffort({ effort: null })).toBeNull();
  });
});
