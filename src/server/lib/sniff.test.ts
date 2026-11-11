import { describe, expect, it } from 'vitest';
import { isPdf, sniffFileMediaType } from './sniff';

function bmp(dibSize: number, reserved = 0): Buffer {
  const header = Buffer.alloc(30);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(30, 2);
  header.writeUInt32LE(reserved, 6);
  header.writeUInt32LE(26, 10);
  header.writeUInt32LE(dibSize, 14);
  return header;
}

function ico(count: number): Buffer {
  return Buffer.from([0x00, 0x00, 0x01, 0x00, count & 0xff, count >> 8, 16, 16]);
}

describe('sniffFileMediaType (ADR-142: magic bytes, never the name)', () => {
  it.each([
    ['PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), 'image/png'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg'],
    ['GIF', Buffer.from('GIF89a....'), 'image/gif'],
    [
      'WebP',
      Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]),
      'image/webp',
    ],
    ['BMP (BITMAPINFOHEADER)', bmp(40), 'image/bmp'],
    ['BMP (v5 header)', bmp(124), 'image/bmp'],
    ['ICO', ico(1), 'image/x-icon'],
    ['PDF', Buffer.from('%PDF-1.4\n'), 'application/pdf'],
  ])('%s → %s', (_name, bytes, type) => {
    expect(sniffFileMediaType(bytes)).toBe(type);
  });

  it.each([
    ['plain text starting with BM', Buffer.from('BMW 320d, Baujahr 2019, 1. Hand')],
    ['BM with non-zero reserved bytes', bmp(40, 1)],
    ['BM with an unknown DIB size', bmp(41)],
    ['ICO with zero images', ico(0)],
    ['SVG (a type by extension only)', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['HTML', Buffer.from('<!doctype html>')],
    ['%PDF without the dash', Buffer.from('%PDF1.4')],
    ['empty', Buffer.alloc(0)],
  ])('%s → null', (_name, bytes) => {
    expect(sniffFileMediaType(bytes)).toBeNull();
  });

  it('isPdf checks the %PDF- prefix only', () => {
    expect(isPdf(Buffer.from('%PDF-'))).toBe(true);
    expect(isPdf(Buffer.from(' %PDF-1.4'))).toBe(false);
    expect(isPdf(Buffer.from('%PD'))).toBe(false);
  });
});
