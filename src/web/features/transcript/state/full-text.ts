import { useCallback, useSyncExternalStore } from 'react';
import { errorPayloadSchema, type ErrorPayload } from '@shared/errors';
import { blobPath } from '@shared/http';
import { showErrorNotice, showTextNotice } from '@web/state/notices';

/**
 * "Vollständig laden" for capped texts (B "Speicher", model.ts §5.5): the full text of a capped
 * value lives as a blob (`GET /api/blob/<id>`, cookie auth). Loaded texts are kept in a small
 * LRU (virtualized rows re-mount), failures show a notice (architecture §2.3i) and can be retried.
 * Phase 1 has only the local host: `sessionKey` is accepted for multi-host blob links (R1W-20).
 */

export type FullTextStatus = 'idle' | 'loading' | 'done' | 'error';

export interface FullTextState {
  status: FullTextStatus;
  text: string | null;
}

/** Loads the full text of a blob; rejects with `BlobLoadError` (an `ErrorPayload` when the server sent one). */
export type FullTextLoader = (blobId: string, sessionKey: string | null) => Promise<string>;

export class BlobLoadError extends Error {
  constructor(readonly payload: ErrorPayload | null) {
    super(payload === null ? 'blob load failed' : payload.code);
    this.name = 'BlobLoadError';
  }
}

async function fetchBlobText(blobId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(blobPath(blobId), { credentials: 'same-origin' });
  } catch {
    throw new BlobLoadError(null);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const payload = errorPayloadSchema.safeParse(body);
    throw new BlobLoadError(payload.success ? payload.data : null);
  }
  return response.text();
}

let loader: FullTextLoader = fetchBlobText;

/** Replaces the loader (playground: generated texts; tests). `null` restores the HTTP loader. */
export function setFullTextLoader(next: FullTextLoader | null): void {
  loader = next ?? fetchBlobText;
}

const MAX_TEXTS = 16;
const IDLE: FullTextState = Object.freeze({ status: 'idle', text: null });
const LOADING: FullTextState = Object.freeze({ status: 'loading', text: null });
const ERROR: FullTextState = Object.freeze({ status: 'error', text: null });
const entries = new Map<string, FullTextState>();
const listeners = new Set<() => void>();

function setEntry(blobId: string, entry: FullTextState): void {
  entries.delete(blobId);
  entries.set(blobId, entry);
  if (entries.size > MAX_TEXTS) {
    for (const [id, value] of entries) {
      if (value.status !== 'loading') {
        entries.delete(id);
        break;
      }
    }
  }
  for (const listener of listeners) listener();
}

/** Starts loading (no-op while loading or when already loaded). */
export function loadFullText(blobId: string, sessionKey: string | null = null): void {
  const current = entries.get(blobId);
  if (current?.status === 'loading' || current?.status === 'done') return;
  setEntry(blobId, LOADING);
  loader(blobId, sessionKey).then(
    (text) => {
      setEntry(blobId, { status: 'done', text });
    },
    (error: unknown) => {
      setEntry(blobId, ERROR);
      const options = { sessionKey, id: `transcript-blob-${blobId}` };
      if (error instanceof BlobLoadError && error.payload !== null) showErrorNotice(error.payload, options);
      else showTextNotice('transcript.capped.loadFailed', undefined, { ...options, tone: 'error' });
    },
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** State of one blob text (`idle` until `loadFullText`). */
export function useFullText(blobId: string | null): FullTextState {
  const getSnapshot = useCallback(() => (blobId === null ? IDLE : (entries.get(blobId) ?? IDLE)), [blobId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Tests only. */
export function resetFullTexts(): void {
  entries.clear();
  loader = fetchBlobText;
  for (const listener of listeners) listener();
}
