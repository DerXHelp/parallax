import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { LIMITS, blobIdSchema } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  BLOB_CSP,
  FILE_PDF_CSP,
  UPLOAD_MEDIA_TYPES,
  attachmentMediaTypeSchema,
  attachmentUploadQuerySchema,
  fileQuerySchema,
  uploadMediaTypeSchema,
  type AttachmentUploadResponse,
} from '@shared/http';
import type { BlobRef } from '@shared/model';
import type { FileContent, FileContentProvider } from '../files/ports';
import { sniffImageType } from '../lib/images';
import { logger as rootLogger } from '../lib/logger';
import { isPdf } from '../lib/sniff';
import { CommandError, type BlobStore } from '../sync/ports';
import { requestPath } from './origin';
import { replyError, sendError } from './reply';

/**
 * Content routes (WP-78b): blob, file content and upload as reusable Fastify registrations with the
 * paths as a parameter. The local app registers them under `API_PATHS` (behind its guard: Host,
 * Origin, Sec-Fetch-Site, cookie); the remote-access listener of a sharing computer registers the
 * same routes under `REMOTE_PATHS` on its own instance (no cookie – the socket is the credential,
 * docs/wp/WP-76.md §B.6) with `beforeEffect`, which is asked right before every delivery or store.
 *
 * The header policy of content answers lives only here: media type (`safeMediaType`, the file
 * service's type), CSP + X-Frame-Options per policy (ADR-142), `nosniff`, `Content-Disposition`,
 * CORP and caching. Error bodies are always an `ErrorPayload` (`contentErrorHandler`).
 */

/**
 * Body limit of an upload: the largest per-type limit (ADR-146); the route checks the limit of the
 * type the magic bytes show (image, PDF, other file).
 */
export const UPLOAD_BODY_LIMIT_BYTES = Math.max(
  LIMITS.imageBytes,
  LIMITS.pdfBytes,
  LIMITS.fileAttachmentBytes,
);

const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9_-]+=[a-z0-9_.-]+)*$/i;

/** Media type from a meta file, or `application/octet-stream` if it is not a plain header value. */
export function safeMediaType(mediaType: string): string {
  return MEDIA_TYPE_PATTERN.test(mediaType) ? mediaType : 'application/octet-stream';
}

/** `type/subtype` of a Content-Type header, lower case, without parameters ('' if absent). */
export function mediaTypeEssence(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/** Header set of a content answer (ADR-142): `blob` = sandbox CSP + DENY, `pdf` = PDF CSP + SAMEORIGIN. */
export function contentPolicyHeaders(policy: FileContent['policy']): Record<string, string> {
  return policy === 'pdf'
    ? { 'content-security-policy': FILE_PDF_CSP, 'x-frame-options': 'SAMEORIGIN' }
    : { 'content-security-policy': BLOB_CSP, 'x-frame-options': 'DENY' };
}

/** A blob served with the PDF header set: meta `application/pdf` and a body that starts with `%PDF-`. */
export function isPdfBlob(ref: Pick<BlobRef, 'mediaType'>, data: Uint8Array): boolean {
  return mediaTypeEssence(ref.mediaType) === 'application/pdf' && isPdf(data);
}

/**
 * `Content-Disposition: inline; filename*=UTF-8''<name>` (RFC 6266/5987): every byte outside the
 * attr-char set percent-encoded – no quote, no line break, no `;` can reach the header.
 */
export function inlineDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename*=UTF-8''${encoded === '' ? 'file' : encoded}`;
}

/**
 * Error handler of the HTTP routes: Fastify's 413/415 (body limit, no parser for the type) and
 * other 4xx map to their catalog codes, everything else is logged and answered as INTERNAL_ERROR.
 * The local app uses it for all routes; the content routes bring it along to another instance.
 */
export function contentErrorHandler(
  log: Logger,
): (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => ErrorPayload {
  return (error, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) return sendError(reply, makeError('PAYLOAD_TOO_LARGE'));
    if (status === 415) return sendError(reply, makeError('UNSUPPORTED_MEDIA_TYPE'));
    if (status >= 400 && status < 500) {
      return sendError(reply, makeError('VALIDATION_FAILED', { reason: error.code }));
    }
    log.error({ err: error, path: requestPath(request.url) }, 'request failed');
    return sendError(reply, makeError('INTERNAL_ERROR'));
  };
}

/** Upload type by magic bytes and declared header type (ADR-103/134/146/157), or an error. */
type UploadKind = { ok: true; mediaType: string; limit: number } | { ok: false; error: ErrorPayload };

/**
 * - Declared image type: the bytes must be an image; CR2-08: a differing image type gives way to the
 *   real one (image limit).
 * - `%PDF-` declared as PDF or octet-stream: a PDF (it needs no preparation, same limit as a file).
 * - Octet-stream: always a file, also with image bytes (CR3-03, ADR-157) – only a declared image was
 *   prepared (scaled) by the client, so only such an upload may become an image block.
 * - Anything else (a declared image/PDF that is none, an empty body) → 415 (R7: no type spoofing).
 */
function uploadKind(body: Buffer, declared: string, name: string | undefined): UploadKind {
  if (attachmentMediaTypeSchema.safeParse(declared).success) {
    const image = sniffImageType(body);
    if (image === null) return { ok: false, error: makeError('UNSUPPORTED_MEDIA_TYPE') };
    return { ok: true, mediaType: image, limit: LIMITS.imageBytes };
  }
  if (isPdf(body) && (declared === 'application/pdf' || declared === 'application/octet-stream')) {
    return { ok: true, mediaType: 'application/pdf', limit: LIMITS.pdfBytes };
  }
  if (declared !== 'application/octet-stream' || body.length === 0) {
    return { ok: false, error: makeError('UNSUPPORTED_MEDIA_TYPE') };
  }
  if (name === undefined) return { ok: false, error: makeError('VALIDATION_FAILED', { reason: 'name' }) };
  return { ok: true, mediaType: 'application/octet-stream', limit: LIMITS.fileAttachmentBytes };
}

/** Route patterns of the three content routes (`API_PATHS`, `REMOTE_PATHS` or a test's own). */
export interface ContentRoutePaths {
  /** Must contain the parameter `:blobId`. */
  blob: string;
  /** GET/HEAD, query `fileQuerySchema`. */
  file: string;
  /** POST, query `attachmentUploadQuerySchema`. */
  attachments: string;
}

export interface ContentRoutesOptions {
  paths: ContentRoutePaths;
  blobs: BlobStore;
  /** File service behind the file route; missing → 501 NOT_IMPLEMENTED. */
  files?: FileContentProvider;
  /**
   * Remote access (WP-76 §B.8): does the coupling of this request's socket still hold? Asked before
   * the body is read and again right before every effect (deliver a blob or a file, store an
   * upload). false → 403 HOST_REVOKED, nothing is delivered or stored. Missing = always allowed
   * (the local app – its guard decides before the route runs).
   */
  beforeEffect?: (request: FastifyRequest) => boolean;
  /** Default: the root logger (the app passes its `http` child). */
  logger?: Logger;
}

/** Headers every content answer carries, also an error answer on an instance without own hooks. */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'x-frame-options': 'DENY',
  'content-security-policy': BLOB_CSP,
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/**
 * Registers the blob, file and upload routes under `options.paths` in an own scope (own error
 * handler, upload parsers only there). It adds no guard: the caller's instance decides who may ask
 * (the app's onRequest guard, the listener's socket classification).
 */
export async function registerContentRoutes(
  app: FastifyInstance,
  options: ContentRoutesOptions,
): Promise<void> {
  const { paths, blobs, beforeEffect } = options;
  if (!paths.blob.includes(':blobId')) throw new Error('content routes: the blob path needs :blobId');
  const log = options.logger ?? rootLogger;
  /** null = may go on; otherwise the answer was prepared (403). */
  const refused = (request: FastifyRequest, reply: FastifyReply): ErrorPayload | null =>
    beforeEffect === undefined || beforeEffect(request) ? null : sendError(reply, makeError('HOST_REVOKED'));

  await app.register(async (scope) => {
    scope.setErrorHandler(contentErrorHandler(log));

    if (beforeEffect !== undefined) {
      // First check before any body is read (an upload of a revoked coupling is never parsed).
      scope.addHook('onRequest', (request, reply, done) => {
        if (beforeEffect(request)) {
          done();
          return;
        }
        replyError(reply, makeError('HOST_REVOKED'));
      });
    }

    // Header policy in one hand: `nosniff` always; the other defaults only where neither the route
    // nor the instance (the app's own onSend hook runs first) chose a value.
    scope.addHook('onSend', (_request, reply, payload, done) => {
      void reply.header('x-content-type-options', 'nosniff');
      for (const [name, value] of Object.entries(BASE_HEADERS)) {
        if (!reply.hasHeader(name)) void reply.header(name, value);
      }
      done(null, payload);
    });

    scope.get<{ Params: { blobId: string } }>(paths.blob, async (request, reply) => {
      const blobId = blobIdSchema.safeParse(request.params.blobId);
      if (!blobId.success) return sendError(reply, makeError('BLOB_NOT_FOUND'));
      const blob = await blobs.get(blobId.data);
      if (blob === null) return sendError(reply, makeError('BLOB_NOT_FOUND'));
      const stop = refused(request, reply);
      if (stop !== null) return stop;
      const data = Buffer.from(blob.data.buffer, blob.data.byteOffset, blob.data.byteLength);
      void reply.headers({
        'content-type': safeMediaType(blob.ref.mediaType),
        // A verified PDF opens in Chrome's viewer (side panel iframe); everything else stays sandboxed.
        ...contentPolicyHeaders(isPdfBlob(blob.ref, data) ? 'pdf' : 'blob'),
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, max-age=31536000, immutable',
      });
      return data;
    });

    // File content (ADR-142): the checks of file.stat (access policy ADR-141, kinds, limits) in the
    // file service; text as UTF-8 (cut at a line end), images/PDFs read whole – `content.bytes` is
    // the exact body length, also for a file changed since its stat (CR3-05). Nothing of the content
    // or the path reaches the log.
    scope.route<{ Querystring: Record<string, unknown> }>({
      method: ['GET', 'HEAD'],
      url: paths.file,
      handler: async (request, reply) => {
        const files = options.files;
        if (files === undefined) return sendError(reply, makeError('NOT_IMPLEMENTED'));
        const query = fileQuerySchema.safeParse(request.query);
        if (!query.success) return sendError(reply, makeError('VALIDATION_FAILED', { reason: 'query' }));
        let content: FileContent;
        try {
          content = await files.open(query.data.entryId, query.data.path);
        } catch (error) {
          if (error instanceof CommandError) return sendError(reply, error.error);
          throw error;
        }
        const stop = refused(request, reply);
        if (stop !== null) {
          content.stream.destroy();
          return stop;
        }
        void reply.headers({
          'content-type': content.mediaType,
          'content-length': String(content.bytes),
          'content-disposition': inlineDisposition(content.name),
          ...contentPolicyHeaders(content.policy),
          'cross-origin-resource-policy': 'same-origin',
          'cache-control': 'no-store',
        });
        if (request.method === 'HEAD') {
          content.stream.destroy();
          return reply.send();
        }
        return reply.send(content.stream);
      },
    });

    // Upload (ADR-103, ADR-146): raw bytes with a Content-Type of UPLOAD_MEDIA_TYPES; any other type
    // has no parser (415), a body over the largest limit hits the body limit (413); both map in the
    // error handler. Declared type and magic bytes decide the type and its limit (`uploadKind`;
    // octet-stream is never an image, CR3-03).
    await scope.register((upload, _opts, done) => {
      upload.removeAllContentTypeParsers();
      upload.addContentTypeParser(
        [...UPLOAD_MEDIA_TYPES],
        { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT_BYTES },
        (_request, body, parsed) => {
          parsed(null, body);
        },
      );
      upload.post(paths.attachments, { bodyLimit: UPLOAD_BODY_LIMIT_BYTES }, (request, reply) => {
        const query = attachmentUploadQuerySchema.safeParse(request.query);
        if (!query.success) return sendError(reply, makeError('VALIDATION_FAILED', { reason: 'query' }));
        const body = request.body;
        const declared = uploadMediaTypeSchema.safeParse(mediaTypeEssence(request.headers['content-type']));
        if (!Buffer.isBuffer(body) || !declared.success) {
          return sendError(reply, makeError('UNSUPPORTED_MEDIA_TYPE'));
        }
        const { name, width, height } = query.data;
        const kind = uploadKind(body, declared.data, name);
        if (!kind.ok) return sendError(reply, kind.error);
        if (body.length > kind.limit) return sendError(reply, makeError('PAYLOAD_TOO_LARGE'));
        const stop = refused(request, reply);
        if (stop !== null) return stop;
        const isImage = kind.mediaType.startsWith('image/');
        const size = isImage && width !== undefined && height !== undefined ? { width, height } : null;
        const attachment = blobs.put(body, kind.mediaType, name ?? null, size);
        log.debug(
          { blobId: attachment.blobId, bytes: attachment.bytes, mediaType: attachment.mediaType },
          'upload',
        );
        const response: AttachmentUploadResponse = { attachment };
        return response;
      });
      done();
    });
  });
}
