import { stat } from 'node:fs/promises';
import path from 'node:path';
import { blobIdSchema, type BlobId, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { windowsPathExtension, windowsPathIssue } from '@shared/paths';
import { nodeFsOps, writeFileAtomic, type FsOps } from '../lib/fs';
import { fsErrorCode } from '../lib/paths';
import { CommandError, type AttachmentFileStore, type BlobStore } from '../sync/ports';
import { entryDir } from './decisions';

/**
 * File attachments of an entry (Phase 3, ADR-146; port `AttachmentFileStore` in sync/ports.ts):
 * `entries/<entryId>/attachments/<first 16 hex of the blob id>/<safe name>`. The engine (WP-51)
 * materializes `application/octet-stream` blobs here before a prompt is sent and passes the folder
 * as an additionalDirectory of every start (C.11); the file service (WP-53) lists the folder as
 * `attached` and treats it as a root (ADR-141). Copies are idempotent (same size → nothing to do)
 * and atomic (`writeFileAtomic`).
 */

export const ATTACHMENTS_DIR = 'attachments';
/** Longest file name of a copy (UTF-16 units, extension included). */
export const ATTACHMENT_NAME_MAX = 120;
const BLOB_PREFIX_CHARS = 16;

/** `<home>\entries\<entryId>\attachments` (the id is validated, so it never escapes the home). */
export function attachmentsDir(home: string, entryId: EntryId): string {
  return path.join(entryDir(home, entryId), ATTACHMENTS_DIR);
}

/** Characters Windows forbids in a file name (replaced; the result is checked by `windowsPathIssue`). */
const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g;
const SAFE_EXTENSION = /^[a-z0-9]{1,10}$/;

/** The path rules live only in `@shared/paths`: a name is probed as the last segment of a drive path. */
function nameIssue(name: string): string | null {
  return windowsPathIssue(`C:\\${name}`);
}

/** Control characters (U+0000–U+001F, U+007F) → `_`. */
function replaceControlChars(name: string): string {
  let out = '';
  for (const char of name) {
    const code = char.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? '_' : char;
  }
  return out;
}

function stripTrailingDotsAndSpaces(name: string): string {
  return name.replace(/[. ]+$/, '');
}

/** Cuts `name` to `max` UTF-16 units without splitting a surrogate pair, keeping a short extension. */
function shorten(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 11 ? name.slice(dot) : '';
  let base = name.slice(0, max - extension.length);
  const last = base.charCodeAt(base.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) base = base.slice(0, -1);
  return `${stripTrailingDotsAndSpaces(base)}${extension}`;
}

/**
 * A Windows-safe file name for `name` (ADR-146), or null if nothing usable is left: only the last
 * path segment; forbidden characters (`<>:"/\|?*`) and control characters → `_`; dots and spaces at
 * the end removed (Windows strips them silently); a reserved device name (`CON`, `NUL.txt`, …) gets
 * a `_` prefix; at most ATTACHMENT_NAME_MAX characters (the extension is kept).
 */
export function sanitizeAttachmentName(name: string | null): string | null {
  if (name === null) return null;
  const segments = name.split(/[\\/]/);
  let safe = replaceControlChars(segments.at(-1) ?? '').replace(FORBIDDEN_CHARS, '_');
  safe = stripTrailingDotsAndSpaces(safe.trimStart());
  if (safe === '') return null;
  if (nameIssue(safe) === 'reserved_name') safe = `_${safe}`;
  safe = shorten(safe, ATTACHMENT_NAME_MAX);
  return safe === '' || nameIssue(safe) !== null ? null : safe;
}

/** Extension of the fallback name `<blob16>.<ext>`: the sanitized name's, else by media type, else `bin`. */
function fallbackExtension(name: string | null, mediaType: string): string {
  const fromName = name === null ? '' : windowsPathExtension(name);
  if (SAFE_EXTENSION.test(fromName)) return fromName;
  if (mediaType === 'application/pdf') return 'pdf';
  const image = /^image\/(png|jpeg|gif|webp)$/.exec(mediaType);
  if (image?.[1] !== undefined) return image[1] === 'jpeg' ? 'jpg' : image[1];
  return 'bin';
}

export interface AttachmentFileStoreOptions {
  /** Write seam (tests inject failures). */
  fs?: FsOps;
  /** Size of an existing copy; null = missing (seam, default `fs.stat`). */
  sizeOf?: (file: string) => Promise<number | null>;
}

async function fileSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT' || fsErrorCode(error) === 'ENOTDIR') return null;
    throw error;
  }
}

export function createAttachmentFileStore(
  home: string,
  blobs: BlobStore,
  options: AttachmentFileStoreOptions = {},
): AttachmentFileStore {
  const fs = options.fs ?? nodeFsOps;
  const sizeOf = options.sizeOf ?? fileSize;

  const dir = async (entryId: EntryId): Promise<string> => {
    const folder = attachmentsDir(home, entryId);
    await fs.mkdir(folder);
    return folder;
  };

  return {
    dir,
    materialize: async (entryId, blobId: BlobId, name) => {
      if (!blobIdSchema.safeParse(blobId).success) throw new CommandError(makeError('BLOB_NOT_FOUND'));
      const blob = await blobs.get(blobId);
      if (blob === null) throw new CommandError(makeError('BLOB_NOT_FOUND'));
      const folder = path.join(attachmentsDir(home, entryId), blobId.slice(0, BLOB_PREFIX_CHARS));
      const safe = sanitizeAttachmentName(name);
      let target = safe === null ? null : path.join(folder, safe);
      if (target === null || windowsPathIssue(target) !== null) {
        const fallback = `${blobId.slice(0, BLOB_PREFIX_CHARS)}.${fallbackExtension(safe, blob.ref.mediaType)}`;
        target = path.join(folder, fallback);
      }
      const issue = windowsPathIssue(target);
      if (issue !== null) throw new CommandError(makeError('PATH_REJECTED', { reason: issue }));
      // Idempotent: the same content under the same name was copied before.
      if ((await sizeOf(target)) === blob.data.byteLength) return target;
      await writeFileAtomic(target, blob.data, { fs });
      return target;
    },
  };
}
