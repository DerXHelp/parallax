import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { sanitizeClaimedName } from './addresses';

describe('sanitizeClaimedName', () => {
  it('removes control and format characters (bidi overrides, zero width) and separators', () => {
    expect(sanitizeClaimedName('PC‮gnp.exe')).toBe('PCgnp.exe');
    expect(sanitizeClaimedName('​Rechner‍ B⁦⁩')).toBe('Rechner B');
    expect(sanitizeClaimedName('a\u0000b\u001bc\u0085d e f')).toBe('abcdef');
  });

  it('trims, cuts at hostNameChars and turns empty into null', () => {
    expect(sanitizeClaimedName('  Rechner B  ')).toBe('Rechner B');
    expect(sanitizeClaimedName('x'.repeat(LIMITS.hostNameChars + 10))).toHaveLength(LIMITS.hostNameChars);
    expect(sanitizeClaimedName('‮​ ')).toBeNull();
    expect(sanitizeClaimedName(null)).toBeNull();
    expect(sanitizeClaimedName(undefined)).toBeNull();
  });
});
