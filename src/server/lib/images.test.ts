import { describe, expect, it } from 'vitest';
import { sniffImageType } from './images';

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : part)),
  );

describe('sniffImageType (magic bytes, ADR-103)', () => {
  it.each([
    ['image/png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR')],
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')],
    ['image/gif', bytes('GIF87a', [1, 0])],
    ['image/gif', bytes('GIF89a', [1, 0])],
    ['image/webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')],
  ])('recognizes %s', (type, data) => {
    expect(sniffImageType(data)).toBe(type);
  });

  it.each([
    ['empty', bytes()],
    ['a short PNG prefix', bytes([0x89, 0x50, 0x4e, 0x47])],
    ['SVG', bytes('<svg onload="alert(1)"/>')],
    ['HTML', bytes('<!doctype html>')],
    ['RIFF without WEBP (WAV)', bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ')],
    ['GIF90a', bytes('GIF90a')],
  ])('rejects %s', (_name, data) => {
    expect(sniffImageType(data)).toBeNull();
  });
});
