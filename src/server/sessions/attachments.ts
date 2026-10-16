/**
 * Image attachments of a prompt (Phase 2, ADR-103; WP-30 §4.12, architecture §5.2): every
 * `blobId` of `session.create.prompt` / `session.sendPrompt` is checked BEFORE any start or send –
 * the blob exists (`BLOB_NOT_FOUND`), is an image type the SDK accepts (`UNSUPPORTED_MEDIA_TYPE`)
 * and stays within `LIMITS.imageBytes` (`PAYLOAD_TOO_LARGE`). Any image blob of this host may be
 * referenced (no binding to the uploading entry, ADR-103). Sent as `OutgoingContent`: the images
 * (base64) first, then the text (an empty text is left out).
 */
import { LIMITS, type BlobId } from '@shared/common';
import { attachmentMediaTypeSchema } from '@shared/http';
import type { BlobRef } from '@shared/model';
import type { OutgoingContent } from '../backend/types';
import type { BlobStore } from '../sync/ports';
import { commandError } from './entryState';

/** The checked attachments of one prompt: refs for the item/queue, image blocks for the CLI. */
export interface PromptAttachments {
  refs: readonly BlobRef[];
  images: readonly Extract<OutgoingContent, { type: 'image' }>[];
}

export const NO_ATTACHMENTS: PromptAttachments = Object.freeze({ refs: [], images: [] });

/** Loads and checks every attachment (in order); throws CommandError on the first bad one. */
export async function resolveAttachments(
  blobs: Pick<BlobStore, 'get'>,
  list: readonly { blobId: BlobId }[],
): Promise<PromptAttachments> {
  if (list.length === 0) return NO_ATTACHMENTS;
  const refs: BlobRef[] = [];
  const images: Extract<OutgoingContent, { type: 'image' }>[] = [];
  for (const { blobId } of list) {
    const blob = await blobs.get(blobId);
    if (blob === null) throw commandError('BLOB_NOT_FOUND', { blobId });
    const mediaType = attachmentMediaTypeSchema.safeParse(blob.ref.mediaType);
    if (!mediaType.success) {
      throw commandError('UNSUPPORTED_MEDIA_TYPE', { blobId, mediaType: blob.ref.mediaType });
    }
    const bytes = Math.max(blob.ref.bytes, blob.data.byteLength);
    if (bytes > LIMITS.imageBytes) {
      throw commandError('PAYLOAD_TOO_LARGE', { blobId, bytes, max: LIMITS.imageBytes });
    }
    refs.push(blob.ref);
    images.push({
      type: 'image',
      mediaType: mediaType.data,
      base64: Buffer.from(blob.data).toString('base64'),
    });
  }
  return { refs, images };
}

/** OutgoingPrompt content: images first, then the text (left out when it is empty/whitespace). */
export function promptContent(text: string, attachments: PromptAttachments): OutgoingContent[] {
  return [...attachments.images, ...(text.trim() === '' ? [] : [{ type: 'text' as const, text }])];
}
