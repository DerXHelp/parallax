/**
 * File type by magic bytes beyond the upload image types (Phase 3, ADR-142/146): BMP, ICO and PDF
 * in addition to `sniffImageType` (lib/images.ts: PNG, JPEG, GIF, WebP). The viewer and the
 * upload never trust a name or a Content-Type alone.
 */
import { sniffImageType } from './images';

export type SniffedMediaType =
  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp' | 'image/x-icon' | 'application/pdf';

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** BITMAPINFOHEADER sizes (core, v1 … v5); "BM" alone also starts plain text ("BMW …"). */
const BMP_DIB_SIZES: ReadonlySet<number> = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** True for a body that starts with `%PDF-`. */
export function isPdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, PDF);
}

/** `BM` + reserved zero bytes + a known DIB header size at offset 14. */
function isBmp(bytes: Uint8Array): boolean {
  if (bytes.length < 18 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
  if (uint32le(bytes, 6) !== 0) return false;
  return BMP_DIB_SIZES.has(uint32le(bytes, 14));
}

/** `00 00 01 00` + at least one image (ICONDIR). */
function isIco(bytes: Uint8Array): boolean {
  if (bytes.length < 6 || !startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return false;
  const count = (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8);
  return count > 0;
}

/** Image or PDF type the bytes start with, null for anything else (text, binary, SVG). */
export function sniffFileMediaType(bytes: Uint8Array): SniffedMediaType | null {
  const image = sniffImageType(bytes);
  if (image !== null) return image;
  if (isBmp(bytes)) return 'image/bmp';
  if (isIco(bytes)) return 'image/x-icon';
  if (isPdf(bytes)) return 'application/pdf';
  return null;
}
