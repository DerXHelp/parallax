/**
 * Image type by magic bytes (ADR-103, R7: the upload never trusts the Content-Type alone).
 * Exactly the SDK's Base64ImageSource types (`ATTACHMENT_MEDIA_TYPES`).
 */
import type { AttachmentMediaType } from '@shared/http';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(text: string): number[] {
  return Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
}

/**
 * The image type the bytes start with: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF
 * `GIF87a`/`GIF89a`, WebP `RIFF????WEBP`; null for anything else.
 */
export function sniffImageType(bytes: Uint8Array): AttachmentMediaType | null {
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}
