import { makeError, errorPayloadSchema, type ErrorPayload } from '@shared/errors';
import { API_PATHS, attachmentUploadResponseSchema } from '@shared/http';
import type { BlobRef } from '@shared/model';
import type { PreparedImage } from './images';

/**
 * Image upload (ADR-103, WP-33 route): `POST /api/attachments?name=…&width=…&height=…` with the raw
 * bytes and the image type as `Content-Type`, cookie auth (`same-origin`). The answer is parsed
 * with `attachmentUploadResponseSchema`, errors with `errorPayloadSchema` (413 PAYLOAD_TOO_LARGE,
 * 415 UNSUPPORTED_MEDIA_TYPE, 400 VALIDATION_FAILED); a failed request is CONNECTION_LOST.
 * The uploader is replaceable (playground: no server behind Vite; tests).
 */

export class UploadError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.code);
    this.name = 'UploadError';
  }
}

export type AttachmentUploader = (image: PreparedImage, signal: AbortSignal) => Promise<BlobRef>;

/** Longest `name` the query schema accepts. */
const NAME_MAX = 260;

function fallbackError(status: number): ErrorPayload {
  if (status === 413) return makeError('PAYLOAD_TOO_LARGE');
  if (status === 415) return makeError('UNSUPPORTED_MEDIA_TYPE');
  if (status === 400) return makeError('VALIDATION_FAILED');
  if (status === 401) return makeError('AUTH_REQUIRED');
  return makeError('INTERNAL_ERROR');
}

/** Query string of the upload (name cut to the schema limit). */
export function uploadQuery(image: Pick<PreparedImage, 'name' | 'width' | 'height'>): string {
  const query = new URLSearchParams({
    name: image.name.slice(0, NAME_MAX),
    width: String(image.width),
    height: String(image.height),
  });
  return `${API_PATHS.attachments}?${query.toString()}`;
}

export const httpUploader: AttachmentUploader = async (image, signal) => {
  let response: Response;
  try {
    response = await fetch(uploadQuery(image), {
      method: 'POST',
      body: image.blob,
      headers: { 'Content-Type': image.type },
      credentials: 'same-origin',
      signal,
    });
  } catch (caught) {
    if (signal.aborted) throw caught;
    throw new UploadError(makeError('CONNECTION_LOST'));
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const payload = errorPayloadSchema.safeParse(body);
    throw new UploadError(payload.success ? payload.data : fallbackError(response.status));
  }
  const parsed = attachmentUploadResponseSchema.safeParse(body);
  if (!parsed.success) throw new UploadError(makeError('INVALID_MESSAGE'));
  return parsed.data.attachment;
};

let uploader: AttachmentUploader = httpUploader;

/** Replaces the uploader (playground, tests); `null` restores the HTTP upload. */
export function setAttachmentUploader(next: AttachmentUploader | null): void {
  uploader = next ?? httpUploader;
}

export function uploadAttachment(image: PreparedImage, signal: AbortSignal): Promise<BlobRef> {
  return uploader(image, signal);
}
