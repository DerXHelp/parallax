import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { LIMITS } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { BlobRef } from '@shared/model';
import {
  decodeWithCanvas,
  ImagePrepareError,
  isAttachmentType,
  prepareImage,
  type ImageDecoder,
  type ImageProblem,
} from '../lib/images';
import { UploadError, uploadAttachment, type UploadRequest } from '../lib/upload';

/**
 * Attachments of the composer per session (ADR-103, ADR-146; WP-37 §4, WP-57): every added file
 * is prepared and uploaded right away; the chips above the field show the state.
 * - Images (`ATTACHMENT_MEDIA_TYPES`) are scaled/encoded first (`lib/images.ts`).
 * - PDFs (≤ `LIMITS.pdfBytes`) go up raw as `application/pdf` – Claude reads them as a document.
 * - Any other file (≤ `LIMITS.fileAttachmentBytes`) goes up raw as `application/octet-stream`
 *   with its name; the engine copies it into the entry's attachment folder and lists its path.
 * A file over its limit gets an error chip without an upload. The server's type (magic bytes)
 * decides the kind of a finished chip. Kept in memory only – a reload loses them (drafts keep the
 * text and the pastes). Sending takes the finished blob ids and clears the list; a failed send
 * restores it.
 */

export type AttachmentKind = 'image' | 'pdf' | 'file';

export type AttachmentStatus = 'preparing' | 'uploading' | 'done' | 'error';

export type AttachmentFailure =
  | { problem: ImageProblem }
  /** Over the limit of its kind (bytes) – not uploaded. */
  | { tooLarge: number }
  | { error: ErrorPayload };

export interface ComposerAttachment {
  /** Local id of the chip. */
  id: string;
  kind: AttachmentKind;
  name: string;
  /** Size of the picked file (after the upload: the stored blob). */
  bytes: number;
  /** Object URL of a picked image (preview); revoked when the chip goes away. */
  previewUrl: string | null;
  status: AttachmentStatus;
  failure: AttachmentFailure | null;
  /** The uploaded blob (`status === 'done'`). */
  ref: BlobRef | null;
}

interface AttachmentState {
  lists: Readonly<Record<string, readonly ComposerAttachment[]>>;
}

const EMPTY: readonly ComposerAttachment[] = Object.freeze([]);
const store = createStore<AttachmentState>(() => ({ lists: {} }));
const controllers = new Map<string, AbortController>();
let counter = 0;
let decode: ImageDecoder = decodeWithCanvas;

/** Replaces the image decoder (tests: happy-dom has no canvas); `null` restores the browser one. */
export function setImageDecoder(next: ImageDecoder | null): void {
  decode = next ?? decodeWithCanvas;
}

const PDF_TYPE = 'application/pdf';

/** Kind of a picked file: its browser type, a PDF also by its extension (no type on some systems). */
export function attachmentKind(file: Pick<File, 'type' | 'name'>): AttachmentKind {
  if (isAttachmentType(file.type)) return 'image';
  if (file.type === PDF_TYPE || (file.type === '' && /\.pdf$/i.test(file.name.trim()))) return 'pdf';
  return 'file';
}

/** Kind of an uploaded blob (the server's type from the magic bytes). */
function kindOfRef(ref: BlobRef, fallback: AttachmentKind): AttachmentKind {
  if (isAttachmentType(ref.mediaType)) return 'image';
  if (ref.mediaType === PDF_TYPE) return 'pdf';
  if (ref.mediaType === 'application/octet-stream') return 'file';
  return fallback;
}

/** Largest file of a kind (images: before scaling there is no fixed limit – the encoder decides). */
export function attachmentLimit(kind: Exclude<AttachmentKind, 'image'>): number {
  return kind === 'pdf' ? LIMITS.pdfBytes : LIMITS.fileAttachmentBytes;
}

/** Sent inline (image/document block) and counted for `LIMITS.attachmentsTotalBytes` (ADR-146). */
export function isInlineAttachment(ref: BlobRef): boolean {
  return isAttachmentType(ref.mediaType) || ref.mediaType === PDF_TYPE;
}

function listOf(sessionKey: string): readonly ComposerAttachment[] {
  return store.getState().lists[sessionKey] ?? EMPTY;
}

function setList(sessionKey: string, list: readonly ComposerAttachment[]): void {
  store.setState((state) => {
    const lists = { ...state.lists };
    if (list.length === 0) Reflect.deleteProperty(lists, sessionKey);
    else lists[sessionKey] = list;
    return { lists };
  });
}

function update(sessionKey: string, id: string, patch: Partial<ComposerAttachment>): void {
  const list = listOf(sessionKey);
  if (!list.some((attachment) => attachment.id === id)) return;
  setList(
    sessionKey,
    list.map((attachment) => (attachment.id === id ? { ...attachment, ...patch } : attachment)),
  );
}

function objectUrl(file: Blob): string | null {
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
}

function revoke(attachment: ComposerAttachment): void {
  if (attachment.previewUrl === null) return;
  try {
    URL.revokeObjectURL(attachment.previewUrl);
  } catch {
    // Nothing to release.
  }
}

/** The upload of one picked file: images prepared first, PDFs and other files raw. */
async function uploadRequest(
  sessionKey: string,
  id: string,
  kind: AttachmentKind,
  file: File,
  name: string,
  removed: () => boolean,
): Promise<UploadRequest | null> {
  if (kind === 'image') {
    const prepared = await prepareImage(file, { decode });
    if (removed()) return null;
    update(sessionKey, id, { status: 'uploading', name: prepared.name, bytes: prepared.blob.size });
    return prepared;
  }
  return { blob: file, type: kind === 'pdf' ? PDF_TYPE : 'application/octet-stream', name };
}

async function processFile(sessionKey: string, attachment: ComposerAttachment, file: File): Promise<void> {
  const { id, kind } = attachment;
  const controller = new AbortController();
  // A function: the chip may be removed (aborted) during every await.
  const removed = () => controller.signal.aborted;
  controllers.set(id, controller);
  try {
    const request = await uploadRequest(sessionKey, id, kind, file, attachment.name, removed);
    if (request === null) return;
    const ref = await uploadAttachment(request, controller.signal);
    if (removed()) return;
    update(sessionKey, id, { status: 'done', ref, bytes: ref.bytes, kind: kindOfRef(ref, kind) });
  } catch (caught) {
    if (removed()) return;
    let failure: AttachmentFailure;
    if (caught instanceof ImagePrepareError) failure = { problem: caught.problem };
    else if (caught instanceof UploadError) failure = { error: caught.payload };
    else failure = { error: makeError('INTERNAL_ERROR') };
    update(sessionKey, id, { status: 'error', failure });
  } finally {
    controllers.delete(id);
  }
}

export interface AddResult {
  added: number;
  /** Files beyond `LIMITS.attachmentsMax`. */
  overLimit: number;
}

/** A chip name: the file name, else a neutral one (a file upload needs a name). */
function chipName(file: File, kind: AttachmentKind): string {
  const name = file.name.trim();
  if (name !== '') return name;
  return kind === 'image' ? 'image' : kind === 'pdf' ? 'document.pdf' : 'file';
}

/** Adds files (paste, drop, paper clip, shell request) and starts preparing + uploading each. */
export function addAttachmentFiles(sessionKey: string, files: readonly File[]): AddResult {
  const room = Math.max(0, LIMITS.attachmentsMax - listOf(sessionKey).length);
  const taken = files.slice(0, room);
  const added: ComposerAttachment[] = taken.map((file) => {
    const kind = attachmentKind(file);
    const limit = kind === 'image' ? null : attachmentLimit(kind);
    const tooLarge = limit !== null && file.size > limit;
    return {
      id: `attachment-${String(++counter)}`,
      kind,
      name: chipName(file, kind),
      bytes: file.size,
      previewUrl: kind === 'image' ? objectUrl(file) : null,
      status: tooLarge ? 'error' : kind === 'image' ? 'preparing' : 'uploading',
      failure: tooLarge ? { tooLarge: limit } : null,
      ref: null,
    };
  });
  if (added.length > 0) setList(sessionKey, [...listOf(sessionKey), ...added]);
  added.forEach((attachment, index) => {
    const file = taken[index];
    if (file !== undefined && attachment.status !== 'error') void processFile(sessionKey, attachment, file);
  });
  return { added: added.length, overLimit: files.length - taken.length };
}

/** Removes a chip (aborts its upload, releases the preview). */
export function removeAttachment(sessionKey: string, id: string): void {
  const list = listOf(sessionKey);
  const attachment = list.find((candidate) => candidate.id === id);
  if (attachment === undefined) return;
  controllers.get(id)?.abort();
  controllers.delete(id);
  revoke(attachment);
  setList(
    sessionKey,
    list.filter((candidate) => candidate.id !== id),
  );
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Chips over the total limit of one prompt (ADR-125/146, `LIMITS.attachmentsTotalBytes`): the
 * bytes of the finished uploads that go inline (images, PDFs) add up in list order; every such chip
 * from the one that crosses the limit on is over. Other files only send their path and never count.
 * Sending waits until such chips are removed – the server would refuse the prompt with
 * `PAYLOAD_TOO_LARGE` anyway.
 */
export function attachmentsOverTotal(
  list: readonly ComposerAttachment[],
  max: number = LIMITS.attachmentsTotalBytes,
): ReadonlySet<string> {
  let total = 0;
  let over: Set<string> | null = null;
  for (const attachment of list) {
    if (attachment.status !== 'done' || attachment.ref === null || !isInlineAttachment(attachment.ref)) {
      continue;
    }
    total += attachment.ref.bytes;
    if (total > max) (over ??= new Set()).add(attachment.id);
  }
  return over ?? NONE;
}

/** Current chips of a session (outside React). */
export function getAttachments(sessionKey: string): readonly ComposerAttachment[] {
  return listOf(sessionKey);
}

/** Takes the chips out for sending (previews stay valid until `releaseAttachments`). */
export function takeAttachments(sessionKey: string): readonly ComposerAttachment[] {
  const list = listOf(sessionKey);
  if (list.length > 0) setList(sessionKey, EMPTY);
  return list;
}

/** Puts taken chips back after a failed send (only into an empty list, else they are released). */
export function restoreAttachments(sessionKey: string, taken: readonly ComposerAttachment[]): void {
  if (taken.length === 0) return;
  if (listOf(sessionKey).length > 0) {
    releaseAttachments(taken);
    return;
  }
  setList(sessionKey, taken);
}

/** Releases the previews of chips that were sent. */
export function releaseAttachments(taken: readonly ComposerAttachment[]): void {
  for (const attachment of taken) revoke(attachment);
}

/** The chips of a session; re-renders on changes. */
export function useAttachments(sessionKey: string): readonly ComposerAttachment[] {
  return useStore(store, (state) => state.lists[sessionKey] ?? EMPTY);
}

/** Tests and playground: abort every upload, release every preview, forget all chips, reset the decoder. */
export function resetAttachments(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  for (const list of Object.values(store.getState().lists)) releaseAttachments(list);
  store.setState({ lists: {} });
  decode = decodeWithCanvas;
}
