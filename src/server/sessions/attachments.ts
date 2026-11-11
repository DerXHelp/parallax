/**
 * Attachments and pastes of a prompt (Phase 2 ADR-103, Phase 3 ADR-146; WP-50 §4.12, architecture
 * §5.2). Every `blobId` of `session.create.prompt` / `session.sendPrompt` is checked BEFORE any
 * start or send (`checkAttachments`): the blob exists (`BLOB_NOT_FOUND`) and is
 * - an image the SDK accepts (≤ `LIMITS.imageBytes`) → `image` block,
 * - a PDF (`application/pdf`, ≤ `LIMITS.pdfBytes`) → `document` block,
 * - another file (`application/octet-stream`, ≤ `LIMITS.fileAttachmentBytes`) → copied into the
 *   entry's attachment folder (`materializeAttachments`, `AttachmentFileStore`) and listed with its
 *   absolute path at the end of the SENT text (`Attached files:` block); without a file store
 *   (engine without WP-53's store) → `UNSUPPORTED_MEDIA_TYPE`,
 * - anything else → `UNSUPPORTED_MEDIA_TYPE`.
 * Images and PDFs together stay within `LIMITS.attachmentsTotalBytes` (ADR-125: `PAYLOAD_TOO_LARGE
 * {bytes, max}` without `blobId`). Any blob of this host may be referenced (ADR-103). The
 * `user_message` item and the queue keep the typed text and every BlobRef; only the CLI sees the
 * path block. Pastes (`prompt.pastes`) must occur verbatim in the typed text (`checkPastes`).
 */
import { LIMITS, type BlobId, type EntryId } from '@shared/common';
import { attachmentMediaTypeSchema } from '@shared/http';
import type { BlobRef } from '@shared/model';
import type { OutgoingContent } from '../backend/types';
import type { AttachmentFileStore, BlobStore } from '../sync/ports';
import { commandError } from './entryState';

/** Fixed English header of the path block appended to the sent text (ADR-146; never shown in the UI). */
export const ATTACHED_FILES_HEADER = 'Attached files:';

export const PDF_MEDIA_TYPE = 'application/pdf';
export const FILE_MEDIA_TYPE = 'application/octet-stream';

type ImageBlock = Extract<OutgoingContent, { type: 'image' }>;
type DocumentBlock = Extract<OutgoingContent, { type: 'document' }>;

/** The checked attachments of one prompt: refs for the item/queue, blocks and file paths for the CLI. */
export interface PromptAttachments {
  /** Every attachment in list order (user_message item, queue entry). */
  refs: readonly BlobRef[];
  /** Image and PDF blocks in list order (sent before the text). */
  blocks: readonly (ImageBlock | DocumentBlock)[];
  /** Other files still to be materialized (list order). */
  files: readonly BlobRef[];
  /** Absolute paths of the materialized files (same order as `files`; empty before materializing). */
  paths: readonly string[];
}

export const NO_ATTACHMENTS: PromptAttachments = Object.freeze({
  refs: [],
  blocks: [],
  files: [],
  paths: [],
});

export interface CheckOptions {
  /** A file store exists: `application/octet-stream` is allowed (ADR-146). */
  files: boolean;
}

/**
 * Loads and checks every attachment (in order); throws CommandError on the first bad one. The raw
 * bytes of all images and PDFs together stay within `LIMITS.attachmentsTotalBytes` (checked while
 * loading, before anything is encoded); files do not count (only their paths are sent).
 */
export async function checkAttachments(
  blobs: Pick<BlobStore, 'get'>,
  list: readonly { blobId: BlobId }[],
  options: CheckOptions,
): Promise<PromptAttachments> {
  if (list.length === 0) return NO_ATTACHMENTS;
  const refs: BlobRef[] = [];
  const blocks: (ImageBlock | DocumentBlock)[] = [];
  const files: BlobRef[] = [];
  let total = 0;
  for (const { blobId } of list) {
    const blob = await blobs.get(blobId);
    if (blob === null) throw commandError('BLOB_NOT_FOUND', { blobId });
    const mediaType = blob.ref.mediaType;
    const bytes = Math.max(blob.ref.bytes, blob.data.byteLength);
    const image = attachmentMediaTypeSchema.safeParse(mediaType);
    if (mediaType === FILE_MEDIA_TYPE && options.files) {
      assertWithin(blobId, bytes, LIMITS.fileAttachmentBytes);
      refs.push(blob.ref);
      files.push(blob.ref);
      continue;
    }
    if (!image.success && mediaType !== PDF_MEDIA_TYPE) {
      throw commandError('UNSUPPORTED_MEDIA_TYPE', { blobId, mediaType });
    }
    assertWithin(blobId, bytes, image.success ? LIMITS.imageBytes : LIMITS.pdfBytes);
    total += bytes;
    if (total > LIMITS.attachmentsTotalBytes) {
      throw commandError('PAYLOAD_TOO_LARGE', { bytes: total, max: LIMITS.attachmentsTotalBytes });
    }
    const base64 = Buffer.from(blob.data).toString('base64');
    refs.push(blob.ref);
    blocks.push(
      image.success
        ? { type: 'image', mediaType: image.data, base64 }
        : { type: 'document', mediaType: PDF_MEDIA_TYPE, base64 },
    );
  }
  return { refs, blocks, files, paths: [] };
}

/**
 * Phase-2 name of the check (used by `http/upload.test.ts`): checks the blobs only, with files
 * allowed – what a wired engine (with WP-53's file store) accepts.
 */
export function resolveAttachments(
  blobs: Pick<BlobStore, 'get'>,
  list: readonly { blobId: BlobId }[],
  options: CheckOptions = { files: true },
): Promise<PromptAttachments> {
  return checkAttachments(blobs, list, options);
}

function assertWithin(blobId: BlobId, bytes: number, max: number): void {
  if (bytes > max) throw commandError('PAYLOAD_TOO_LARGE', { blobId, bytes, max });
}

/**
 * Copies the files of checked attachments into the entry's attachment folder (ADR-146; the store
 * is idempotent) and returns them with their absolute paths. The entry must exist (session.create:
 * after the entry was created). Throws what the store throws (CommandError BLOB_NOT_FOUND).
 */
export async function materializeAttachments(
  store: AttachmentFileStore | null,
  entryId: EntryId,
  attachments: PromptAttachments,
): Promise<PromptAttachments> {
  if (attachments.files.length === 0) return attachments;
  if (store === null) {
    // checkAttachments never lets a file through without a store; keep the rule in one place anyway.
    const first = attachments.files[0];
    throw commandError('UNSUPPORTED_MEDIA_TYPE', {
      blobId: first?.blobId ?? '',
      mediaType: first?.mediaType ?? FILE_MEDIA_TYPE,
    });
  }
  const paths: string[] = [];
  for (const ref of attachments.files) paths.push(await store.materialize(entryId, ref.blobId, ref.name));
  return { ...attachments, paths };
}

/** The text the CLI gets: the typed text plus – with files – the `Attached files:` block at its end. */
export function sentText(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const block = `${ATTACHED_FILES_HEADER}${paths.map((p) => `\n- ${p}`).join('')}`;
  return text.trim() === '' ? block : `${text}\n\n${block}`;
}

/** OutgoingPrompt content: image/PDF blocks first, then the sent text (left out when empty/whitespace). */
export function promptContent(text: string, attachments: PromptAttachments): OutgoingContent[] {
  const sent = sentText(text, attachments.paths);
  return [...attachments.blocks, ...(sent.trim() === '' ? [] : [{ type: 'text' as const, text: sent }])];
}

/**
 * ADR-146: every paste occurs verbatim in the typed text, else `VALIDATION_FAILED {reason:
 * 'paste_not_in_text', index}`. Returns the pastes for `OutgoingPrompt.inlinePastes`.
 */
export function checkPastes(text: string, pastes: readonly string[]): readonly string[] {
  const index = pastes.findIndex((paste) => !text.includes(paste));
  if (index >= 0) throw commandError('VALIDATION_FAILED', { reason: 'paste_not_in_text', index });
  return pastes;
}
