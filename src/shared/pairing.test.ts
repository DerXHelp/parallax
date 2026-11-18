import { describe, expect, it } from 'vitest';
import {
  PAIRING_CODE_BYTES,
  PAIRING_CODE_CHARS,
  formatPairingCode,
  isValidPairingCode,
  parsePairingCode,
} from './pairing';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic pseudo-random bytes (xorshift) – shared code has no crypto API. */
function bytesFor(seed: number): Uint8Array {
  let x = seed * 2654435761 || 1;
  const out = new Uint8Array(PAIRING_CODE_BYTES);
  for (let i = 0; i < out.length; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

const strip = (code: string): string => code.replaceAll('-', '');

describe('pairing code', () => {
  it('formats 16 bytes as 7 groups of 4 and parses them back', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const bytes = bytesFor(seed);
      const code = formatPairingCode(bytes);
      expect(code).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{3}(?:-[0-9A-HJKMNP-TV-Z]{4}){6}$/u);
      expect(strip(code)).toHaveLength(PAIRING_CODE_CHARS);
      expect(parsePairingCode(code)).toEqual(bytes);
    }
  });

  it('covers the extremes', () => {
    const zero = new Uint8Array(PAIRING_CODE_BYTES);
    const max = new Uint8Array(PAIRING_CODE_BYTES).fill(0xff);
    expect(formatPairingCode(zero)).toBe('0000-0000-0000-0000-0000-0000-0000');
    expect(parsePairingCode(formatPairingCode(zero))).toEqual(zero);
    expect(formatPairingCode(max).startsWith('7')).toBe(true);
    expect(parsePairingCode(formatPairingCode(max))).toEqual(max);
    expect(() => formatPairingCode(new Uint8Array(15))).toThrow(RangeError);
  });

  it('accepts lower case, spaces, missing dashes and Crockford look-alikes', () => {
    const bytes = bytesFor(7);
    const code = formatPairingCode(bytes);
    expect(parsePairingCode(code.toLowerCase())).toEqual(bytes);
    expect(parsePairingCode(` ${strip(code).replace(/(.{4})/gu, '$1 ')} `)).toEqual(bytes);
    const withLookAlikes = code.replaceAll('0', 'O').replaceAll('1', 'l');
    expect(parsePairingCode(withLookAlikes)).toEqual(bytes);
  });

  it('rejects wrong lengths, unknown characters, U and a first character above 7', () => {
    const code = strip(formatPairingCode(bytesFor(3)));
    expect(parsePairingCode(code.slice(1))).toBeNull();
    expect(parsePairingCode(`${code}0`)).toBeNull();
    expect(parsePairingCode(`U${code.slice(1)}`)).toBeNull();
    expect(parsePairingCode(`${code.slice(0, 5)}*${code.slice(6)}`)).toBeNull();
    expect(parsePairingCode(`8${code.slice(1)}`)).toBeNull();
    expect(parsePairingCode('')).toBeNull();
    expect(isValidPairingCode(code)).toBe(true);
    expect(isValidPairingCode(code.slice(2))).toBe(false);
  });

  it('detects every single wrong character and every swap of neighbours', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const code = strip(formatPairingCode(bytesFor(seed)));
      for (let i = 0; i < code.length; i += 1) {
        for (const c of ALPHABET) {
          if (c === code[i]) continue;
          expect(parsePairingCode(code.slice(0, i) + c + code.slice(i + 1))).toBeNull();
        }
      }
      for (let i = 0; i + 1 < code.length; i += 1) {
        const a = code[i] ?? '';
        const b = code[i + 1] ?? '';
        if (a === b) continue;
        expect(parsePairingCode(code.slice(0, i) + b + a + code.slice(i + 2))).toBeNull();
      }
    }
  });
});
