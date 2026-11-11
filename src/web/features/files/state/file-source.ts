import type { EntryId } from '@shared/common';
import { errorPayloadSchema, makeError, type ErrorPayload } from '@shared/errors';
import { fileUrl } from '@shared/http';

/**
 * Where the viewer gets file CONTENT from (WP-54, ADR-142): by default `GET /api/file` of the own
 * origin (`fetch` same-origin, `no-store`; `<img>`/`<iframe>` use the same URL). Playground and tests
 * replace it with `setFileSource` – no server needed (the "loader seam" for wave 2).
 * Metadata never comes from here: `file.stat` goes over the WebSocket like every command.
 */

/** A failed content request with the server's ErrorPayload (or a client-side substitute). */
export class FileLoadError extends Error {
  readonly error: ErrorPayload;
  constructor(error: ErrorPayload) {
    super(error.message ?? error.code);
    this.name = 'FileLoadError';
    this.error = error;
  }
}

/** Where a file lives: the session (host), its entry and the absolute path. */
export interface FileRef {
  sessionKey: string;
  entryId: EntryId;
  path: string;
}

export interface FileSource {
  /** Text of a text/Markdown file as GET /api/file sends it (UTF-8, maybe cut); rejects with FileLoadError. */
  text(file: FileRef, signal: AbortSignal): Promise<string>;
  /** URL of the content for `<img>`, `<iframe>` and "Download". */
  url(file: FileRef): string;
}

async function errorOf(response: Response): Promise<ErrorPayload> {
  try {
    const parsed = errorPayloadSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // Not a JSON error body.
  }
  return makeError(response.status === 404 ? 'FILE_NOT_FOUND' : 'INTERNAL_ERROR', {
    status: response.status,
  });
}

/** The real source: `GET /api/file?entryId&path` of this origin (cookie, Sec-Fetch-Site same-origin). */
export const httpFileSource: FileSource = {
  async text(file, signal) {
    let response: Response;
    try {
      response = await fetch(fileUrl(file.entryId, file.path), {
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new FileLoadError(makeError('CONNECTION_LOST'));
    }
    if (!response.ok) throw new FileLoadError(await errorOf(response));
    return response.text();
  },
  url: (file) => fileUrl(file.entryId, file.path),
};

let current: FileSource = httpFileSource;

/** Replaces the content source (playground, tests); `null` restores GET /api/file. */
export function setFileSource(source: FileSource | null): void {
  current = source ?? httpFileSource;
}

export function getFileSource(): FileSource {
  return current;
}

/** ErrorPayload of anything a load threw (FileLoadError → its payload). */
export function loadErrorOf(error: unknown): ErrorPayload {
  return error instanceof FileLoadError ? error.error : makeError('INTERNAL_ERROR');
}
