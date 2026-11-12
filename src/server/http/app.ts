import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  fastify,
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import type { Logger } from 'pino';
import { LIMITS, blobIdSchema } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  API_PATHS,
  BLOB_CSP,
  DEV_AUTH_CODE_TTL_MS,
  DEV_WEB_PORT,
  FILE_PDF_CSP,
  UPLOAD_MEDIA_TYPES,
  appUrlWithCode,
  attachmentMediaTypeSchema,
  attachmentUploadQuerySchema,
  fileQuerySchema,
  pageCsp,
  serverOrigin,
  uploadMediaTypeSchema,
  type AttachmentUploadResponse,
  type BackendKind,
  type HealthResponse,
} from '@shared/http';
import type { BlobRef } from '@shared/model';
import { PRODUCT_ID } from '@shared/product';
import { WS_CLOSE } from '@shared/protocol';
import type { ServerConfig, ServerInstance } from '../config';
import type { FileContent, FileContentProvider } from '../files/ports';
import { sniffImageType } from '../lib/images';
import { logger as rootLogger } from '../lib/logger';
import { isPdf } from '../lib/sniff';
import { CommandError, type BlobStore } from '../sync/ports';
import { registerAuthRoutes, type AuthService } from './auth';
import { STATIC_ROUTE, checkRequest, requestPath } from './origin';
import { replyError, sendError } from './reply';

/**
 * The Fastify app (docs/architecture.md §5.1): request guard (Host/Origin/Sec-Fetch-Site + device
 * cookie, also for the WS upgrade – @fastify/websocket dispatches upgrades through the normal
 * hook chain), security headers + CSP (C.10), `/api/health`, auth routes, blobs, the upload
 * `POST /api/attachments` (images ADR-103; PDFs and other files ADR-146), file content
 * `GET /api/file` (ADR-142), the WS route of the hub and the static web UI. Never CORS headers.
 * WP-20/WP-60 wire it: `createApp({ config, instance, auth, blobs, hub, files })` → `app.listen(…)`.
 *
 * The guard classifies by the matched route (`request.routeOptions.url`), not by the URL text
 * (R1-01, ADR-018); the WS route repeats the whole check itself (second line, `authorizeUpgrade`).
 */

/** Options of `AttachableHub.attach` (the app hands the hub its WS authorization). */
export interface HubAttachOptions {
  /**
   * Second line of the WS guard (R1-01): Host, request target, Origin, Sec-Fetch-Site and cookie
   * of the upgrade request, independent of the global hook. null = authorized; otherwise the hub
   * answers the error over HTTP (preValidation) and never upgrades.
   */
  authorizeUpgrade(request: FastifyRequest): ErrorPayload | null;
}

/** What createApp needs from the sync hub (sync/hub.ts). */
export interface AttachableHub {
  /** Registers the WS route (`GET /api/ws`) on the app. */
  attach(app: FastifyInstance, options: HubAttachOptions): void;
  closeAll(code: number): void;
}

export interface CreateAppOptions {
  /** `backend` (R3-02) is reported by `/api/health` when given. */
  config: Pick<ServerConfig, 'port' | 'dev'> & { backend?: BackendKind };
  instance: ServerInstance;
  auth: AuthService;
  blobs: BlobStore;
  hub?: AttachableHub;
  /** File service behind `GET /api/file` (Phase 3, ADR-142); missing → 501 NOT_IMPLEMENTED. */
  files?: FileContentProvider;
  /** Built web UI (`dist/web`); not served when null or missing (dev mode uses Vite). */
  webRoot?: string | null;
  logger?: Logger;
}

/** Body limit of the JSON routes (the upload has its own: UPLOAD_BODY_LIMIT_BYTES, C.11). */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024;
/**
 * Body limit of `POST /api/attachments`: the largest per-type limit (ADR-146); the route checks
 * the limit of the type the magic bytes show (image, PDF, other file).
 */
export const UPLOAD_BODY_LIMIT_BYTES = Math.max(
  LIMITS.imageBytes,
  LIMITS.pdfBytes,
  LIMITS.fileAttachmentBytes,
);
/** Sockets that ignore the shutdown close frame are terminated after this delay. */
export const WS_SHUTDOWN_GRACE_MS = 1000;

// The page CSP (C.10) and the blob CSP come from @shared/http (`pageCsp`, `BLOB_CSP`; R3-14).

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

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const log = (options.logger ?? rootLogger).child({ module: 'http' });
  const { auth, blobs, instance } = options;
  const dev = options.config.dev;

  // Typed as the base logger so the app is a plain FastifyInstance (plugins, hub.attach).
  const fastifyLogger: FastifyBaseLogger = log;
  const app = fastify({
    loggerInstance: fastifyLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: JSON_BODY_LIMIT_BYTES,
  });

  /**
   * Actual listening port (config port 0 → the OS-assigned one); null while it is not known yet:
   * port 0 before `listen` (CR-07 – only `inject` reaches the app then).
   */
  const knownPort = (): number | null => {
    const address = app.server.address();
    if (address !== null && typeof address === 'object') return address.port;
    return options.config.port === 0 ? null : options.config.port;
  };
  /** For the routes: they run only after the guard accepted the request, i.e. with a known port. */
  const port = (): number => knownPort() ?? options.config.port;

  // ---- WebSocket plugin (explicit maxPayload, C.11) ----
  // Registered before the guard: its onRequest hook marks upgrade requests, so a rejected
  // upgrade's socket is destroyed after the HTTP error answer (plugin onResponse hook).
  await app.register(fastifyWebsocket, {
    options: { maxPayload: LIMITS.wsMaxPayloadBytes },
    preClose(done) {
      const clients = [...this.websocketServer.clients];
      for (const client of clients) client.close(WS_CLOSE.SERVER_SHUTDOWN, 'server shutdown');
      setTimeout(() => {
        for (const client of clients) client.terminate();
      }, WS_SHUTDOWN_GRACE_MS).unref();
      done();
    },
  });

  /**
   * Guard (§5.1) + device cookie for `request`, classified by the route pattern `route` (null =
   * no route matched). Returns the error to answer, or null.
   */
  const authorize = (
    request: FastifyRequest,
    route: string | null,
    upgrade: boolean,
  ): ErrorPayload | null => {
    const currentPort = knownPort();
    // CR-07: no Host header can name a server whose port is not known yet (never a RangeError/500).
    if (currentPort === null) return makeError('HOST_HEADER_REJECTED');
    const result = checkRequest(
      { method: request.method, url: request.url, route, upgrade, headers: request.headers },
      { port: currentPort, dev },
    );
    if (!result.ok) {
      log.warn(
        {
          method: request.method,
          path: requestPath(request.url).slice(0, 200),
          route,
          class: result.route,
          upgrade,
          host: request.headers.host ?? null,
          origin: request.headers.origin ?? null,
          site: request.headers['sec-fetch-site'] ?? null,
          error: result.error,
        },
        'request rejected',
      );
      return result.error;
    }
    if (result.needsCookie && !auth.isAuthenticated(request.headers.cookie, currentPort)) {
      return makeError('AUTH_REQUIRED');
    }
    return null;
  };

  /** Upgrade request: @fastify/websocket marks it (`request.ws`); the header covers a reordered hook chain. */
  const isUpgrade = (request: FastifyRequest): boolean => request.ws || request.headers.upgrade !== undefined;

  // ---- guard: Host / request target / Origin / Sec-Fetch-Site / cookie (also for WS upgrades) ----
  app.addHook('onRequest', (request, reply, done) => {
    // Routing has already happened: classify by the matched route, never by the URL text (R1-01).
    const error = authorize(request, request.routeOptions.url ?? null, isUpgrade(request));
    if (error !== null) {
      replyError(reply, error);
      return;
    }
    done();
  });

  // ---- security headers (C.10); no CORS headers, ever ----
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.headers({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
    });
    // DENY unless a route chose its header set itself (PDF answers: SAMEORIGIN, ADR-142).
    if (!reply.hasHeader('x-frame-options')) void reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('cross-origin-resource-policy'))
      void reply.header('cross-origin-resource-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) {
      // CR-07: without a known port (only an error answer) the strictest policy, never a throw.
      const currentPort = knownPort();
      void reply.header('content-security-policy', currentPort === null ? BLOB_CSP : pageCsp(currentPort));
    }
    // Everything but the static UI (API answers, errors, 404) is never cached.
    if (request.routeOptions.url !== STATIC_ROUTE && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) return sendError(reply, makeError('PAYLOAD_TOO_LARGE'));
    if (status === 415) return sendError(reply, makeError('UNSUPPORTED_MEDIA_TYPE'));
    if (status >= 400 && status < 500) {
      return sendError(reply, makeError('VALIDATION_FAILED', { reason: error.code }));
    }
    log.error({ err: error, path: requestPath(request.url) }, 'request failed');
    return sendError(reply, makeError('INTERNAL_ERROR'));
  });

  // Unknown routes and missing static files (R1-12, V1-06).
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, makeError('ROUTE_NOT_FOUND', { path: requestPath(request.url).slice(0, 200) })),
  );

  // ---- routes ----
  const backend = options.config.backend;
  app.get(API_PATHS.health, (): HealthResponse => ({
    ok: true,
    product: PRODUCT_ID,
    serverInstanceId: instance.serverInstanceId,
    serverVersion: instance.serverVersion,
    buildId: instance.buildId,
    startedAt: instance.startedAt,
    ...(backend === undefined ? {} : { backend }),
  }));

  registerAuthRoutes(app, auth, { port });

  app.get<{ Params: { blobId: string } }>(API_PATHS.blob, async (request, reply) => {
    const blobId = blobIdSchema.safeParse(request.params.blobId);
    if (!blobId.success) return sendError(reply, makeError('BLOB_NOT_FOUND'));
    const blob = await blobs.get(blobId.data);
    if (blob === null) return sendError(reply, makeError('BLOB_NOT_FOUND'));
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
  // file service; text as UTF-8 (cut at a line end), images/PDFs streamed. Guard class "file"
  // (Sec-Fetch-Site same-origin required, Origin if present allowed, cookie). Nothing of the
  // content or the path reaches the log.
  app.route<{ Querystring: Record<string, unknown> }>({
    method: ['GET', 'HEAD'],
    url: API_PATHS.file,
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
  // error handler above. Declared type and magic bytes decide the type and its limit (`uploadKind`;
  // octet-stream is never an image, CR3-03). Guard class
  // "mutation" (Origin, same-origin, cookie) – unchanged.
  await app.register((scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      [...UPLOAD_MEDIA_TYPES],
      { parseAs: 'buffer', bodyLimit: UPLOAD_BODY_LIMIT_BYTES },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    scope.post(API_PATHS.attachments, { bodyLimit: UPLOAD_BODY_LIMIT_BYTES }, (request, reply) => {
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

  if (options.hub !== undefined) {
    const hub = options.hub;
    // Second line: the WS route checks the upgrade again, independent of the onRequest hook.
    hub.attach(app, { authorizeUpgrade: (request) => authorize(request, API_PATHS.ws, true) });
    const off = auth.onRevoked(() => {
      hub.closeAll(WS_CLOSE.AUTH_REVOKED);
    });
    app.addHook('onClose', (_instance, done) => {
      off();
      done();
    });
  }

  if (options.webRoot !== undefined && options.webRoot !== null && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        // The HTML must always be revalidated (new build id → new asset names).
        if (filePath.endsWith('.html')) void reply.header('cache-control', 'no-cache');
      },
    });
  }

  // ---- dev mode: one login URL in the log (only in dev a code reaches the log, §5.1) ----
  if (dev) {
    app.addHook('onListen', (done) => {
      const issued = auth.issueAuthCode(DEV_AUTH_CODE_TTL_MS);
      log.info(
        { url: appUrlWithCode(serverOrigin(DEV_WEB_PORT), issued.code), expiresAt: issued.expiresAt },
        'dev login URL',
      );
      done();
    });
  }

  return app;
}
