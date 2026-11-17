import type { z } from 'zod';
import { errorPayloadSchema, makeError, type ErrorPayload } from '@shared/errors';
import {
  API_PATHS,
  UPDATE_PACKAGE_MAX_BYTES,
  changelogResponseSchema,
  noticesResponseSchema,
  updatePackageResponseSchema,
  type ChangelogQuery,
  type ChangelogResponse,
  type NoticeFile,
  type NoticesResponse,
} from '@shared/http';

/**
 * HTTP of the update UI (WP-87 §1.4): `GET /api/changelog`, `GET /api/notices` (guard class
 * "file": cookie, same-origin) and `POST /api/update/package` (zip, guard class "mutation"). Every
 * answer is parsed with its zod schema; an error answer as `ErrorPayload` (else a code from the
 * HTTP status); a failed request is CONNECTION_LOST.
 */

export class UpdateHttpError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.code);
    this.name = 'UpdateHttpError';
  }
}

/** The payload of anything an update request threw. */
export function updateHttpErrorOf(caught: unknown): ErrorPayload {
  return caught instanceof UpdateHttpError ? caught.payload : makeError('INTERNAL_ERROR');
}

function fallbackError(status: number): ErrorPayload {
  switch (status) {
    case 401:
      return makeError('AUTH_REQUIRED');
    case 404:
      return makeError('FILE_NOT_FOUND');
    case 413:
      return makeError('PAYLOAD_TOO_LARGE');
    case 415:
      return makeError('UNSUPPORTED_MEDIA_TYPE');
    default:
      return makeError('INTERNAL_ERROR', { status });
  }
}

async function request(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (caught) {
    if (init.signal?.aborted === true) throw caught;
    throw new UpdateHttpError(makeError('CONNECTION_LOST'));
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const payload = errorPayloadSchema.safeParse(body);
    throw new UpdateHttpError(payload.success ? payload.data : fallbackError(response.status));
  }
  return body;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new UpdateHttpError(makeError('INVALID_MESSAGE'));
  return result.data;
}

/** `/api/changelog?for=…[&since=…]`. */
export function changelogUrl(query: ChangelogQuery): string {
  const params = new URLSearchParams({ for: query.for });
  if (query.since !== undefined) params.set('since', query.since);
  return `${API_PATHS.changelog}?${params.toString()}`;
}

/** `/api/notices?file=…`. */
export function noticesUrl(file: NoticeFile): string {
  return `${API_PATHS.notices}?${new URLSearchParams({ file }).toString()}`;
}

/** The three requests; replaceable for the playground (no server behind Vite there). */
export interface UpdateHttp {
  changelog(query: ChangelogQuery, signal: AbortSignal): Promise<ChangelogResponse>;
  notices(file: NoticeFile, signal: AbortSignal): Promise<NoticesResponse>;
  upload(file: Blob): Promise<void>;
}

export const httpUpdateRequests: UpdateHttp = {
  async changelog(query, signal) {
    const body = await request(changelogUrl(query), { cache: 'no-store', signal });
    return parsed(changelogResponseSchema, body);
  },
  async notices(file, signal) {
    const body = await request(noticesUrl(file), { cache: 'no-store', signal });
    return parsed(noticesResponseSchema, body);
  },
  /**
   * "Install from file": the zip as the raw body with `Content-Type: application/zip`, whatever
   * type the browser guessed. Bigger than `UPDATE_PACKAGE_MAX_BYTES` → PAYLOAD_TOO_LARGE without
   * sending. 202 = accepted; checking and staging then show in `HostState.update`.
   */
  async upload(file) {
    if (file.size > UPDATE_PACKAGE_MAX_BYTES) throw new UpdateHttpError(makeError('PAYLOAD_TOO_LARGE'));
    const body = await request(API_PATHS.updatePackage, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/zip' },
    });
    parsed(updatePackageResponseSchema, body);
  },
};

let requests: UpdateHttp = httpUpdateRequests;

/** Replaces the requests (playground); `null` restores HTTP. */
export function setUpdateHttp(next: UpdateHttp | null): void {
  requests = next ?? httpUpdateRequests;
}

export function fetchChangelog(query: ChangelogQuery, signal: AbortSignal): Promise<ChangelogResponse> {
  return requests.changelog(query, signal);
}

export function fetchNotices(file: NoticeFile, signal: AbortSignal): Promise<NoticesResponse> {
  return requests.notices(file, signal);
}

export function uploadUpdatePackage(file: Blob): Promise<void> {
  return requests.upload(file);
}
