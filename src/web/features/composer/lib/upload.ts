import { makeError, errorPayloadSchema, type ErrorPayload } from '@shared/errors';
import { API_PATHS, attachmentUploadResponseSchema, type UploadMediaType } from '@shared/http';
import type { BlobRef } from '@shared/model';

/**
 * Attachment upload (ADR-103, ADR-146; WP-33/53 route): `POST /api/attachments?name=…[&width=…&height=…]`
 * with the raw bytes and the type as `Content-Type` – an image type (prepared image), PDF, or
 * `application/octet-stream` for any other file (`name` required then; the server decides by magic
 * bytes). Cookie auth (`same-origin`). The answer is parsed with `attachmentUploadResponseSchema`,
 * errors with `errorPayloadSchema` (413 PAYLOAD_TOO_LARGE, 415 UNSUPPORTED_MEDIA_TYPE, 400
 * VALIDATION_FAILED); a failed request is CONNECTION_LOST. The uploader is replaceable
 * (playground: no server behind Vite; tests).
 */

export class UploadError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.code);
    this.name = 'UploadError';
  }
}

/** One upload: the bytes, their header type and the name; width/height only for images. */
export interface UploadRequest {
  blob: Blob;
  type: UploadMediaType;
  name: string;
  width?: number | null;
  height?: number | null;
}

export type AttachmentUploader = (upload: UploadRequest, signal: AbortSignal) => Promise<BlobRef>;

/** Longest `name` the query schema accepts. */
export const UPLOAD_NAME_MAX = 260;

function fallbackError(status: number): ErrorPayload {
  if (status === 413) return makeError('PAYLOAD_TOO_LARGE');
  if (status === 415) return makeError('UNSUPPORTED_MEDIA_TYPE');
  if (status === 400) return makeError('VALIDATION_FAILED');
  if (status === 401) return makeError('AUTH_REQUIRED');
  return makeError('INTERNAL_ERROR');
}

/** `name` cut to the schema limit; a short extension (≤ 10 characters) survives the cut. */
export function uploadName(name: string): string {
  if (name.length <= UPLOAD_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 11 ? name.slice(dot) : '';
  return `${name.slice(0, UPLOAD_NAME_MAX - extension.length)}${extension}`;
}

/** Query string of the upload (name cut to the schema limit, size only for images). */
export function uploadQuery(upload: Pick<UploadRequest, 'name' | 'width' | 'height'>): string {
  const query = new URLSearchParams({ name: uploadName(upload.name) });
  if (typeof upload.width === 'number' && typeof upload.height === 'number') {
    query.set('width', String(upload.width));
    query.set('height', String(upload.height));
  }
  return `${API_PATHS.attachments}?${query.toString()}`;
}

export const httpUploader: AttachmentUploader = async (upload, signal) => {
  let response: Response;
  try {
    response = await fetch(uploadQuery(upload), {
      method: 'POST',
      body: upload.blob,
      headers: { 'Content-Type': upload.type },
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

export function uploadAttachment(upload: UploadRequest, signal: AbortSignal): Promise<BlobRef> {
  return uploader(upload, signal);
}
