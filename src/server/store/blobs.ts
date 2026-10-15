import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { blobIdSchema, type BlobId } from '@shared/common';
import { blobRefSchema, type BlobRef } from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import type { BlobStore } from '../sync/ports';
import { writeFileAtomic } from './jsonStore';

/**
 * Content-addressed blob cache (B "Speicher", architecture §8): `blobs/<sha256>` with the raw
 * bytes and `blobs/<sha256>.meta.json` (`blobRefSchema`, R0-30). `put` hashes synchronously and
 * writes asynchronously (normalizer contract, WP-02 §9.4); until the write is done `get` serves
 * the bytes from memory. The first meta file of a content wins.
 */

export const BLOBS_DIR = 'blobs';
export const BLOB_META_SUFFIX = '.meta.json';

const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/**
 * `put` never throws for odd metadata from the SDK (R1-20: the normalizer passes `media_type`
 * unchecked): an empty or over-long media type becomes `application/octet-stream`, a long name is
 * cut to the schema limit. The served Content-Type is sanitized again (http/app.ts safeMediaType).
 */
function blobMeta(mediaType: string, name: string | null): { mediaType: string; name: string | null } {
  const type = mediaType.trim();
  return {
    mediaType: type === '' || type.length > 100 ? FALLBACK_MEDIA_TYPE : type,
    name: name === null ? null : name.slice(0, 260),
  };
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

export function createBlobStore(options: BlobStoreOptions): FileBlobStore {
  const log = (options.logger ?? rootLogger).child({ module: 'blobs' });
  const pending = new Map<BlobId, PendingBlob>();
  const refs = new Map<BlobId, BlobRef>();
  const writes = new Set<Promise<void>>();

  const write = async (blob: PendingBlob) => {
    const dataFile = blobFilePath(options.home, blob.ref.blobId);
    const metaFile = blobMetaPath(options.home, blob.ref.blobId);
    if (!(await exists(dataFile))) await writeFileAtomic(dataFile, blob.data);
    if (!(await exists(metaFile))) await writeFileAtomic(metaFile, `${JSON.stringify(blob.ref, null, 2)}\n`);
  };

  return {
    put: (data, mediaType, name = null) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      const blobId = createHash('sha256').update(bytes).digest('hex');
      const known = refs.get(blobId);
      if (known !== undefined) return known;
      const ref = blobRefSchema.parse({ blobId, ...blobMeta(mediaType, name), bytes: bytes.byteLength });
      refs.set(blobId, ref);
      const blob: PendingBlob = { data: bytes, ref };
      pending.set(blobId, blob);
      const job = write(blob)
        .then(() => {
          pending.delete(blobId);
        })
        .catch((error: unknown) => {
          // Stays in memory for this process; the next put of the same content does not retry.
          log.error({ err: error, blobId }, 'blob write failed');
        });
      writes.add(job);
      void job.finally(() => writes.delete(job));
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
