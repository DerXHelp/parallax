/**
 * Text encoding detection and conversion for the file viewer (Phase 3, ADR-142): BOM (UTF-8,
 * UTF-16LE/BE), NUL bytes → binary (like git), valid UTF-8, otherwise windows-1252. GET /api/file
 * always answers UTF-8, cut at a line end.
 */
import type { TextEncoding } from '@shared/model';

/** Bytes looked at for the detection (ADR-142). */
export const TEXT_SNIFF_BYTES = 64 * 1024;

export type TextDetection = TextEncoding | 'binary';

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function isValidUtf8(bytes: Uint8Array, complete: boolean): boolean {
  try {
    // `stream: true` accepts a multi-byte sequence cut at the end of a sample.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

/**
 * Encoding of a text by its first bytes (`complete` = `sample` is the whole file): a BOM decides;
 * otherwise a NUL byte means binary, valid UTF-8 means UTF-8, anything else windows-1252.
 */
export function detectTextEncoding(sample: Uint8Array, complete: boolean): TextDetection {
  if (startsWith(sample, UTF8_BOM)) return 'utf-8';
  if (startsWith(sample, UTF16LE_BOM)) return 'utf-16le';
  if (startsWith(sample, UTF16BE_BOM)) return 'utf-16be';
  if (sample.includes(0)) return 'binary';
  return isValidUtf8(sample, complete) ? 'utf-8' : 'windows-1252';
}

/** Length of the byte order mark of `encoding` at the start of `bytes` (0 if none). */
export function bomLength(bytes: Uint8Array, encoding: TextEncoding): number {
  switch (encoding) {
    case 'utf-8':
      return startsWith(bytes, UTF8_BOM) ? 3 : 0;
    case 'utf-16le':
      return startsWith(bytes, UTF16LE_BOM) ? 2 : 0;
    case 'utf-16be':
      return startsWith(bytes, UTF16BE_BOM) ? 2 : 0;
    case 'windows-1252':
      return 0;
  }
}

/**
 * `bytes` as a string without the BOM. `cut` = the bytes end inside the file: an incomplete
 * multi-byte sequence (or half a UTF-16 unit) at the end is dropped instead of becoming U+FFFD.
 */
export function decodeText(bytes: Uint8Array, encoding: TextEncoding, cut: boolean): string {
  const body = bytes.subarray(bomLength(bytes, encoding));
  return new TextDecoder(encoding, { ignoreBOM: true }).decode(body, { stream: cut });
}

const NEWLINE = 0x0a;

/**
 * UTF-8 bytes of at most `max` bytes, cut after the last line end (`\n`) inside that window. With
 * `force` (the source itself was cut, so the last line is incomplete) the cut happens even when the
 * buffer already fits. Without any line end the cut falls on a character boundary.
 */
export function cutUtf8AtLineEnd(buffer: Buffer, max: number, force = false): Buffer {
  if (!force && buffer.length <= max) return buffer;
  const window = Math.min(buffer.length, max);
  const newline = buffer.lastIndexOf(NEWLINE, window - 1);
  if (newline >= 0) return buffer.subarray(0, newline + 1);
  if (window === buffer.length) return buffer;
  let end = window;
  // Never split a multi-byte character (continuation bytes are 10xxxxxx).
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}
