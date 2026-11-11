import { describe, expect, it } from 'vitest';
import { bomLength, cutUtf8AtLineEnd, decodeText, detectTextEncoding } from './textDecode';

describe('detectTextEncoding (ADR-142)', () => {
  it.each([
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x41]), 'utf-8'],
    ['UTF-16LE BOM', Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'utf-16le'],
    ['UTF-16BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x41]), 'utf-16be'],
    ['UTF-16 without BOM (NUL bytes)', Buffer.from('A\0B\0'), 'binary'],
    ['a NUL byte in text', Buffer.from('abc\0def'), 'binary'],
    ['plain ASCII', Buffer.from('hello\n'), 'utf-8'],
    ['valid UTF-8 with umlauts', Buffer.from('Grüße – ✓\n', 'utf8'), 'utf-8'],
    ['windows-1252 umlauts', Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]), 'windows-1252'],
    ['empty', Buffer.alloc(0), 'utf-8'],
  ])('%s → %s', (_name, bytes, expected) => {
    expect(detectTextEncoding(bytes, true)).toBe(expected);
  });

  it('a multi-byte character cut at the end of a SAMPLE is still UTF-8, at the end of the FILE it is not', () => {
    const cut = Buffer.from('abc ü', 'utf8').subarray(0, 5); // 'abc ' + first byte of ü
    expect(detectTextEncoding(cut, false)).toBe('utf-8');
    expect(detectTextEncoding(cut, true)).toBe('windows-1252');
  });
});

describe('decodeText', () => {
  it('drops the BOM and decodes every supported encoding', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xc3, 0xa4]), 'utf-8', false)).toBe('aä');
    expect(
      decodeText(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße', 'utf16le')]),
        'utf-16le',
        false,
      ),
    ).toBe('Grüße');
    const be = Buffer.from('Hi', 'utf16le').swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'utf-16be', false)).toBe('Hi');
    expect(decodeText(Buffer.from([0x80, 0xe4, 0x9f]), 'windows-1252', false)).toBe('€äŸ');
    expect(bomLength(Buffer.from('abc'), 'utf-8')).toBe(0);
    expect(bomLength(Buffer.from([0xff, 0xfe]), 'windows-1252')).toBe(0);
  });

  it('cut = true drops an incomplete trailing sequence instead of U+FFFD', () => {
    const cut = Buffer.from('aä', 'utf8').subarray(0, 2);
    expect(decodeText(cut, 'utf-8', true)).toBe('a');
    expect(decodeText(cut, 'utf-8', false)).toBe('a�');
    const halfUnit = Buffer.from('ab', 'utf16le').subarray(0, 3);
    expect(decodeText(halfUnit, 'utf-16le', true)).toBe('a');
  });
});

describe('cutUtf8AtLineEnd', () => {
  it('keeps a buffer that fits', () => {
    const text = Buffer.from('a\nb');
    expect(cutUtf8AtLineEnd(text, 10)).toBe(text);
  });

  it('cuts after the last line end inside the window', () => {
    expect(cutUtf8AtLineEnd(Buffer.from('one\ntwo\nthree\n'), 9).toString()).toBe('one\ntwo\n');
    expect(cutUtf8AtLineEnd(Buffer.from('one\r\ntwo\r\nthree'), 12).toString()).toBe('one\r\ntwo\r\n');
  });

  it('force: cuts the incomplete last line even when the buffer fits', () => {
    expect(cutUtf8AtLineEnd(Buffer.from('one\ntwo\npartial'), 100, true).toString()).toBe('one\ntwo\n');
    // Without any line end in the window the whole forced buffer stays.
    expect(cutUtf8AtLineEnd(Buffer.from('partial'), 100, true).toString()).toBe('partial');
  });

  it('without a line end it cuts on a character boundary', () => {
    const text = Buffer.from('aaää', 'utf8'); // 2 + 2×2 bytes
    expect(cutUtf8AtLineEnd(text, 3).toString()).toBe('aa');
    expect(cutUtf8AtLineEnd(text, 4).toString()).toBe('aaä');
  });
});
