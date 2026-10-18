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
import { UploadError, uploadAttachment } from '../lib/upload';

/**
 * Image attachments of the composer per session (ADR-103, WP-37 §4): every added image is
 * prepared (scaled/encoded) and uploaded right away; the chips above the field show the state.
 * Kept in memory only – a reload loses them (drafts keep only the text). Sending takes the
 * finished blob ids and clears the list; a failed send restores it.
 */

export type AttachmentStatus = 'preparing' | 'uploading' | 'done' | 'error';

export type AttachmentFailure = { problem: ImageProblem } | { error: ErrorPayload };

export interface ComposerAttachment {
  /** Local id of the chip. */
  id: string;
  name: string;
  /** Object URL of the picked file (preview); revoked when the chip goes away. */
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

async function processFile(sessionKey: string, id: string, file: File): Promise<void> {
  const controller = new AbortController();
  // A function: the chip may be removed (aborted) during every await.
  const removed = () => controller.signal.aborted;
  controllers.set(id, controller);
  try {
    const prepared = await prepareImage(file, { decode });
    if (removed()) return;
    update(sessionKey, id, { status: 'uploading', name: prepared.name });
    const ref = await uploadAttachment(prepared, controller.signal);
    if (removed()) return;
    update(sessionKey, id, { status: 'done', ref });
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
  /** Files of another type (only images are accepted). */
  notImages: number;
  /** Images beyond `LIMITS.attachmentsMax`. */
  overLimit: number;
}

/** Adds image files (paste, drop, paper clip) and starts preparing + uploading each. */
export function addAttachmentFiles(sessionKey: string, files: readonly File[]): AddResult {
  const images = files.filter((file) => isAttachmentType(file.type));
  const room = Math.max(0, LIMITS.attachmentsMax - listOf(sessionKey).length);
  const taken = images.slice(0, room);
  const added: ComposerAttachment[] = taken.map((file) => ({
    id: `attachment-${String(++counter)}`,
    name: file.name.trim() === '' ? 'image' : file.name,
    previewUrl: objectUrl(file),
    status: 'preparing',
    failure: null,
    ref: null,
  }));
  if (added.length > 0) setList(sessionKey, [...listOf(sessionKey), ...added]);
  added.forEach((attachment, index) => {
    const file = taken[index];
    if (file !== undefined) void processFile(sessionKey, attachment.id, file);
  });
  return {
    added: added.length,
    notImages: files.length - images.length,
    overLimit: images.length - taken.length,
  };
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
