import { LOCAL_HOST_ID, type HostId } from '@shared/common';
import { hostBlobPath } from '@shared/http';
import type { BlobRef } from '@shared/model';
import { extensionForMediaType } from '@web/lib/media-types';

/**
 * Image sources of the transcript: `/api/blob/<id>` (same origin, cookie – CSP `img-src 'self'`).
 * The playground has no server behind Vite and replaces the resolver with generated `data:` URLs.
 * WP-80: an image of another computer's session comes through this server's forwarding route
 * `/api/hosts/<id>/blob/<id>` (`hostBlobPath`, same origin); the transcript passes its computer
 * via `BlobHostContext` (context.ts).
 */

export type BlobSourceResolver = (blobId: string) => string | null;

let resolver: BlobSourceResolver | null = null;

/** Replaces the source of blob images (playground); `null` restores `/api/blob/<id>`. */
export function setBlobSourceResolver(next: BlobSourceResolver | null): void {
  resolver = next;
}

export function blobSource(blobId: string, hostId: HostId = LOCAL_HOST_ID): string {
  return resolver?.(blobId) ?? hostBlobPath(hostId, blobId);
}

/** File name for "Save as": the blob's name, else `image-<id prefix>.<extension of the type>`. */
export function downloadNameOf(ref: Pick<BlobRef, 'blobId' | 'mediaType' | 'name'>): string {
  const name = ref.name?.trim() ?? '';
  if (name !== '') return name;
  const extension = extensionForMediaType(ref.mediaType) ?? 'bin';
  return `image-${ref.blobId.slice(0, 12)}.${extension}`;
}
