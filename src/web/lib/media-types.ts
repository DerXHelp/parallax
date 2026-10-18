/**
 * File extensions of media types (R4W-21): one table for the composer (names of prepared image
 * attachments) and the transcript ("Save as" names of blob images). Display/naming only – which
 * types may be uploaded decides `ATTACHMENT_MEDIA_TYPES` (`@shared/http`) and the server.
 */

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

/**
 * Extension (without the dot) of `mediaType`, case-insensitive and without parameters
 * (`image/PNG; foo=1` → `png`); null for an unknown type.
 */
export function extensionForMediaType(mediaType: string): string | null {
  const type = (mediaType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return Object.hasOwn(EXTENSIONS, type) ? (EXTENSIONS[type] ?? null) : null;
}

/**
 * `name` with the extension of `mediaType` (`shot.png` + JPEG → `shot.jpg`; an empty name becomes
 * `fallback`). Unknown types keep the name as it is.
 */
export function fileNameForMediaType(name: string, mediaType: string, fallback = 'image'): string {
  const trimmed = name.trim() === '' ? fallback : name.trim();
  const extension = extensionForMediaType(mediaType);
  if (extension === null) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${base}.${extension}`;
}
