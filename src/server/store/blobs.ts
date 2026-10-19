import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { blobIdSchema, type BlobId } from '@shared/common';
import { blobRefSchema, type BlobRef } from '@shared/model';
import { sniffImageType } from '../lib/images';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import type { BlobStore } from '../sync/ports';
import { writeFileAtomic } from './jsonStore';

/**
 * Content-addressed blob cache (B "Speicher", architecture §8): `blobs/<sha256>` with the raw
 * bytes and `blobs/<sha256>.meta.json` (`blobRefSchema`, R0-30). `put` hashes synchronously and
 * writes asynchronously (normalizer contract, WP-02 §9.4); until the write is done `get` serves
 * the bytes from memory. Phase 2: `put(…, size)` stores the pixel size of an uploaded image
 * (`width`/`height`, ADR-103).
 *
 * One meta per content: the first one wins, unless a later put brings a better one (CR2-07,
 * ADR-134, `replacesMeta`) – the image type its magic bytes confirm instead of another stored type
 * (e.g. `application/octet-stream` from the normalizer), or as an upload (the only put with a pixel
 * size) a different name/size of that type. Decided against the in-memory ref and again against
 * the meta file (also after a restart); writes of one content run one after another.
 */

export const BLOBS_DIR = 'blobs';
export const BLOB_META_SUFFIX = '.meta.json';

const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/**
 * `put` never throws for odd metadata from the SDK (R1-20: the normalizer passes `media_type`
 * unchecked): an empty or over-long media type becomes `application/octet-stream`, a long name is
 * cut to the schema limit. The served Content-Type is sanitized again (http/app.ts safeMediaType).
 */
function blobMeta(
  mediaType: string,
  name: string | null,
  size: { width: number; height: number } | null,
): Pick<BlobRef, 'mediaType' | 'name' | 'width' | 'height'> {
  const type = mediaType.trim();
  // Phase 2 (ADR-103): pixel size of an uploaded image; only a complete, plausible pair is kept.
  const pixels = size !== null && isPixelCount(size.width) && isPixelCount(size.height) ? size : null;
  return {
    mediaType: type === '' || type.length > 100 ? FALLBACK_MEDIA_TYPE : type,
    name: name === null ? null : name.slice(0, 260),
    width: pixels?.width ?? null,
    height: pixels?.height ?? null,
  };
}

function isPixelCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * CR2-07: does the meta of a put (`next`) replace the stored meta of the same content? Only a meta
 * whose type the magic bytes confirm (`verified`) can: it replaces another stored type, and an
 * upload's (pixel size given, ADR-103) a different name or size of that type – the latest upload
 * wins. A put without both (the normalizer) never replaces: otherwise the first meta wins.
 */
function replacesMeta(stored: BlobRef, next: BlobRef, verified: string | null): boolean {
  if (verified === null || next.mediaType !== verified) return false;
  if (stored.mediaType !== verified) return true;
  return (
    next.width !== null &&
    (stored.name !== next.name || stored.width !== next.width || stored.height !== next.height)
  );
}

export function blobFilePath(home: string, blobId: BlobId): string {
  return path.join(home, BLOBS_DIR, blobIdSchema.parse(blobId));
}

export function blobMetaPath(home: string, blobId: BlobId): string {
  return `${blobFilePath(home, blobId)}${BLOB_META_SUFFIX}`;
}

export interface BlobStoreOptions {
  home: string;
  logger?: Logger;
}

export interface FileBlobStore extends BlobStore {
  /** Waits for all pending writes. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface PendingBlob {
  data: Uint8Array;
  ref: BlobRef;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The meta file of a blob: missing, a valid ref, invalid (overwritten), or unreadable (kept). */
type StoredMeta =
  { state: 'missing' } | { state: 'valid'; ref: BlobRef } | { state: 'invalid' } | { state: 'unreadable' };

async function readStoredMeta(file: string, blobId: BlobId): Promise<StoredMeta> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return fsErrorCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  const ref = blobRefSchema.safeParse(raw);
  return ref.success && ref.data.blobId === blobId ? { state: 'valid', ref: ref.data } : { state: 'invalid' };
}

export function createBlobStore(options: BlobStoreOptions): FileBlobStore {
  const log = (options.logger ?? rootLogger).child({ module: 'blobs' });
  const pending = new Map<BlobId, PendingBlob>();
  const refs = new Map<BlobId, BlobRef>();
  const writes = new Set<Promise<void>>();
  /** Last write job per content: writes of one content never overlap (CR2-07). */
  const chains = new Map<BlobId, Promise<void>>();

  const write = async (blob: PendingBlob, verified: string | null) => {
    const { blobId } = blob.ref;
    const dataFile = blobFilePath(options.home, blobId);
    const metaFile = blobMetaPath(options.home, blobId);
    if (!(await exists(dataFile))) await writeFileAtomic(dataFile, blob.data);
    const stored = await readStoredMeta(metaFile, blobId);
    if (stored.state === 'unreadable') return;
    if (stored.state === 'valid' && !replacesMeta(stored.ref, blob.ref, verified)) {
      // The meta on disk stays (e.g. from an earlier run); later puts of this process answer it.
      if (refs.get(blobId) === blob.ref) refs.set(blobId, stored.ref);
      return;
    }
    await writeFileAtomic(metaFile, `${JSON.stringify(blob.ref, null, 2)}\n`);
  };

  return {
    put: (data, mediaType, name = null, size = null) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      const blobId = createHash('sha256').update(bytes).digest('hex');
      const ref = blobRefSchema.parse({
        blobId,
        ...blobMeta(mediaType, name, size),
        bytes: bytes.byteLength,
      });
      const verified = sniffImageType(bytes);
      const known = refs.get(blobId);
      if (known !== undefined && !replacesMeta(known, ref, verified)) return known;
      refs.set(blobId, ref);
      const blob: PendingBlob = { data: bytes, ref };
      pending.set(blobId, blob);
      const job = (chains.get(blobId) ?? Promise.resolve())
        .then(() => write(blob, verified))
        .then(() => {
          if (pending.get(blobId) === blob) pending.delete(blobId);
        })
        .catch((error: unknown) => {
          // Stays in memory for this process; the next put of the same content does not retry.
          log.error({ err: error, blobId }, 'blob write failed');
        });
      chains.set(blobId, job);
      writes.add(job);
      void job.finally(() => {
        writes.delete(job);
        if (chains.get(blobId) === job) chains.delete(blobId);
      });
      return ref;
    },
    get: async (blobId) => {
      if (!blobIdSchema.safeParse(blobId).success) return null;
      const inMemory = pending.get(blobId);
      if (inMemory !== undefined) return { data: inMemory.data, ref: inMemory.ref };
      let metaText: string;
      let data: Buffer;
      try {
        [metaText, data] = await Promise.all([
          readFile(blobMetaPath(options.home, blobId), 'utf8'),
          readFile(blobFilePath(options.home, blobId)),
        ]);
      } catch (error) {
        if (fsErrorCode(error) === 'ENOENT') return null;
        throw error;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(metaText);
      } catch {
        raw = null;
      }
      const ref = blobRefSchema.safeParse(raw);
      if (!ref.success || ref.data.blobId !== blobId) {
        log.warn({ blobId }, 'blob meta file invalid');
        return null;
      }
      return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), ref: ref.data };
    },
    flush: async () => {
      await Promise.all([...writes]);
    },
    close: async () => {
      await Promise.all([...writes]);
    },
  };
}
