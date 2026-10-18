import { blobPath } from '@shared/http';
import type { BlobRef } from '@shared/model';

/**
 * Image sources of the transcript: `/api/blob/<id>` (same origin, cookie – CSP `img-src 'self'`).
 * The playground has no server behind Vite and replaces the resolver with generated `data:` URLs.
 * Phase 2 has only the local host (multi-host blob links later, R1W-20).
 */

export type BlobSourceResolver = (blobId: string) => string | null;

let resolver: BlobSourceResolver | null = null;

/** Replaces the source of blob images (playground); `null` restores `/api/blob/<id>`. */
export function setBlobSourceResolver(next: BlobSourceResolver | null): void {
  resolver = next;
}

export function blobSource(blobId: string): string {
  return resolver?.(blobId) ?? blobPath(blobId);
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** File name for "Save as": the blob's name, else `image-<id prefix>.<extension of the type>`. */
export function downloadNameOf(ref: Pick<BlobRef, 'blobId' | 'mediaType' | 'name'>): string {
  const name = ref.name?.trim() ?? '';
  if (name !== '') return name;
  const extension = EXTENSIONS[ref.mediaType] ?? 'bin';
  return `image-${ref.blobId.slice(0, 12)}.${extension}`;
}
