import { createHash } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { WebSocket } from 'ws';
import { LIMITS, blobIdSchema, type HostId } from '@shared/common';
import { errorPayloadSchema, makeError, type ErrorCode, type ErrorPayload } from '@shared/errors';
import {
  HOST_API_PATHS,
  REMOTE_PATHS,
  UPLOAD_MEDIA_TYPES,
  attachmentUploadQuerySchema,
  attachmentUploadResponseSchema,
  fileQuerySchema,
  uploadMediaTypeSchema,
} from '@shared/http';
import { remoteHostIdSchema } from '@shared/model';
import { pathFlavorOfShape, pathRules } from '@shared/paths';
import { WS_CLOSE } from '@shared/protocol';
import type { HostsService, UpstreamRequest, UpstreamResponse } from '../hosts/ports';
import { closeReason } from '../hosts/windows';
import { logger as rootLogger } from '../lib/logger';
import { isPdf } from '../lib/sniff';
import {
  UPLOAD_BODY_LIMIT_BYTES,
  contentErrorHandler,
  contentPolicyHeaders,
  inlineDisposition,
  mediaTypeEssence,
} from './content';
import { replyError, sendError } from './reply';
import { BRIDGE_LIMITS, bridgeWindow, forwardFailure, type BridgeLimits } from './hostSocket';

/**
 * Forwarder routes of the controlling computer (docs/wp/WP-76.md §B.6 "Vermittler", WP-75 §4.3):
 * `HOST_API_PATHS` under this server's own origin, behind the same guard as the local routes of
 * the same class (origin.ts: `blob`, `file`, `ws`; the upload is a `mutation`) – the browser never
 * talks to another computer itself.
 *
 * - The hostId must be in the list of computers (HOST_NOT_FOUND otherwise).
 * - The other computer only gets paths of a fixed mapping: blob → REMOTE_PATHS.blob with a checked
 *   blobId, file → REMOTE_PATHS.file with a query rebuilt from `fileQuerySchema`, attachments →
 *   REMOTE_PATHS.attachments with a query rebuilt from `attachmentUploadQuerySchema` and the body
 *   limit of the local upload. Never a path, header or query text from the request.
 * - Response headers come from this server by the rules of content.ts (CSP/X-Frame-Options per
 *   policy, `nosniff`, Content-Disposition, CORP, caching); nothing of the other side's headers is
 *   taken unchecked. The media type comes from a closed set (`forwardedMediaType`: the types the file
 *   service and attachments produce); any other is served as `application/octet-stream` download. A blob's bytes must hash to
 *   its id; bodies are capped. Errors of the other side pass only from a per-route allowlist with
 *   short params, everything else is HOST_UNREACHABLE.
 * - WebSocket: one connection to the other computer per browser connection (hostSocket.ts).
 */

/** Served for a type outside FORWARDED_MEDIA_TYPES (with `Content-Disposition: attachment`). */
const DOWNLOAD_MEDIA_TYPE = 'application/octet-stream';

/**
 * The media types a forwarded answer may carry (essence → the header sent here): what GET /api/file
 * serves (text, the sniffed images, SVG, PDF – files/stat.ts) and blobs hold (attachments).
 */
const FORWARDED_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ['text/plain', 'text/plain; charset=utf-8'],
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/gif', 'image/gif'],
  ['image/webp', 'image/webp'],
  ['image/svg+xml', 'image/svg+xml'],
  ['application/pdf', 'application/pdf'],
]);

/** The header for the other side's Content-Type, or null when it is outside the closed set. */
export function forwardedMediaType(header: string | undefined): string | null {
  return FORWARDED_MEDIA_TYPES.get(mediaTypeEssence(header)) ?? null;
}

export interface HostRoutesOptions {
  hosts: Pick<HostsService, 'list' | 'forwarder'>;
  /** The app's second line for the upgrade (Host, Origin, Sec-Fetch-Site, cookie; class `ws`). */
  authorizeUpgrade(request: FastifyRequest): ErrorPayload | null;
  logger?: Logger;
  /** Window bridge limits (tests). */
  bridge?: Partial<BridgeLimits>;
  /** Limits of forwarded content requests (tests). */
  forward?: Partial<ForwardLimits>;
}

/**
 * Limits of a forwarded content request (security review WP-82): a slow, stalled or hostile other
 * computer must never hold the browser's few connections to this server – local routes would stall
 * too. Headers within `headersMs` (uploads: `uploadHeadersMs`, the body goes first), then at least
 * `minBytesPerWindow` per `windowMs` until the body is complete; at most `perHost` at a time.
 */
export interface ForwardLimits {
  headersMs: number;
  uploadHeadersMs: number;
  minBytesPerWindow: number;
  windowMs: number;
  perHost: number;
}

export const FORWARD_LIMITS: ForwardLimits = {
  headersMs: 30_000,
  uploadHeadersMs: 120_000,
  minBytesPerWindow: 16 * 1024,
  windowMs: 10_000,
  perHost: 16,
};

export interface HostRoutes {
  /** Closes every forwarded window of the browser side (device signed out: AUTH_REVOKED). */
  closeAll(code: number): void;
  /** Open forwarded windows (diagnostics and tests). */
  windowCount(): number;
}

/** Largest blob or file body passed on (the file service's binary limit is the largest content). */
export const FORWARDED_BODY_MAX_BYTES = Math.max(LIMITS.fileBinaryBytes, UPLOAD_BODY_LIMIT_BYTES);
/** Largest JSON answer of an upload or error read from the other computer. */
const SMALL_ANSWER_BYTES = 64 * 1024;

const COMMON_ERRORS = [
  'VALIDATION_FAILED',
  'NOT_IMPLEMENTED',
  'HOST_REVOKED',
  'HOST_INCOMPATIBLE',
  'PAYLOAD_TOO_LARGE',
] as const satisfies readonly ErrorCode[];

/** Errors of the other computer that reach the browser (with sanitized params). */
const PASSED_ERRORS: Readonly<Record<'blob' | 'file' | 'attachments', ReadonlySet<ErrorCode>>> = {
  blob: new Set<ErrorCode>([...COMMON_ERRORS, 'BLOB_NOT_FOUND']),
  file: new Set<ErrorCode>([
    ...COMMON_ERRORS,
    'ENTRY_NOT_FOUND',
    'FILE_NOT_FOUND',
    'FILE_NOT_READABLE',
    'FILE_TYPE_BLOCKED',
    'PATH_REJECTED',
    'PATH_NOT_ALLOWED',
    'CWD_NOT_FOUND',
    'CWD_NOT_DIRECTORY',
    'UNSUPPORTED_MEDIA_TYPE',
  ]),
  attachments: new Set<ErrorCode>([...COMMON_ERRORS, 'UNSUPPORTED_MEDIA_TYPE']),
};

const PARAMS_MAX = 8;
const PARAM_CHARS = 200;

/** At most PARAMS_MAX params (already plain values by `paramsSchema`) with short strings. */
function shortParams(params: ErrorPayload['params']): ErrorPayload['params'] {
  const out: ErrorPayload['params'] = {};
  for (const [key, value] of Object.entries(params).slice(0, PARAMS_MAX)) {
    if (key.length > 64) continue;
    out[key] = typeof value === 'string' ? value.slice(0, PARAM_CHARS) : value;
  }
  return out;
}

/** Reads at most `max` bytes (more → null). Never rejects. */
async function readSmall(body: Readable, max = SMALL_ANSWER_BYTES): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > max) {
        body.destroy();
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer | null): unknown {
  if (body === null) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

/** The error of a non-200 answer of the other computer, as this server passes it on. */
async function upstreamError(
  response: UpstreamResponse,
  route: keyof typeof PASSED_ERRORS,
): Promise<ErrorPayload> {
  const body = await readSmall(response.body);
  const parsed = errorPayloadSchema.safeParse(parseJson(body));
  if (parsed.success && PASSED_ERRORS[route].has(parsed.data.code)) {
    return makeError(parsed.data.code, shortParams(parsed.data.params));
  }
  return makeError('HOST_UNREACHABLE', { reason: `status_${String(response.status)}` });
}

/** A Content-Length of the other side that this server repeats (decimal, within `max`), or null. */
function declaredLength(response: UpstreamResponse, max: number): number | null {
  const raw = response.headers['content-length'];
  if (raw === undefined || !/^\d{1,12}$/u.test(raw)) return null;
  const value = Number(raw);
  return value <= max ? value : null;
}

/** Ends the reply stream with an error: the transfer is cut (never a whole wrong body). */
class ForwardedBodyError extends Error {
  constructor(readonly reason: 'size' | 'hash' | 'length' | 'slow') {
    super(`forwarded body rejected (${reason})`);
    this.name = 'ForwardedBodyError';
  }
}

interface BodyCheck {
  maxBytes: number;
  /** Exact length announced to the browser. */
  length: number | null;
  /** sha256 hex the bytes must have (blobs): the last chunk is held back until it matched. */
  sha256?: string;
}

/**
 * The upstream body with its first chunks already read (`head`), checked while it streams:
 * size cap, announced length and, for blobs, the content hash.
 */
function checkedBody(
  head: Buffer[],
  rest: AsyncIterator<unknown>,
  source: Readable,
  check: BodyCheck,
): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    const hash = check.sha256 === undefined ? null : createHash('sha256');
    let total = 0;
    let held: Buffer | null = null;
    const take = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > check.maxBytes || (check.length !== null && total > check.length)) {
        throw new ForwardedBodyError('size');
      }
      hash?.update(chunk);
    };
    try {
      const queue = [...head];
      for (;;) {
        let chunk = queue.shift();
        if (chunk === undefined) {
          const next = await rest.next();
          if (next.done === true) break;
          chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
        }
        take(chunk);
        if (hash === null) {
          yield chunk;
          continue;
        }
        if (held !== null) yield held;
        held = chunk;
      }
      if (check.length !== null && total !== check.length) throw new ForwardedBodyError('length');
      if (hash !== null && hash.digest('hex') !== check.sha256) throw new ForwardedBodyError('hash');
      if (held !== null) yield held;
    } finally {
      source.destroy();
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

/** Reads until at least `bytes` bytes (or the end) are there – for the PDF check. */
async function readHead(rest: AsyncIterator<unknown>, bytes: number): Promise<Buffer[]> {
  const head: Buffer[] = [];
  let size = 0;
  while (size < bytes) {
    const next = await rest.next();
    if (next.done === true) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array);
    head.push(chunk);
    size += chunk.length;
  }
  return head;
}

const PDF_MAGIC_BYTES = 5;

export async function registerHostRoutes(
  app: FastifyInstance,
  options: HostRoutesOptions,
): Promise<HostRoutes> {
  const log = options.logger ?? rootLogger;
  const { hosts } = options;
  const bridgeLimits: BridgeLimits = { ...BRIDGE_LIMITS, ...options.bridge };
  const forwardLimits: ForwardLimits = { ...FORWARD_LIMITS, ...options.forward };
  const sockets = new Set<WebSocket>();
  /** Forwarded content requests per computer that have not finished their answer yet. */
  const inflight = new Map<HostId, number>();

  /** The hostId of the path if it names a computer of the list, else null. */
  const knownHost = (raw: string): HostId | null => {
    const parsed = remoteHostIdSchema.safeParse(raw);
    if (!parsed.success) return null;
    return hosts.list().some((host) => host.hostId === parsed.data) ? parsed.data : null;
  };

  /** Aborts the upstream request when the browser goes away before the answer is complete. */
  const abortOnClose = (reply: FastifyReply): AbortSignal => {
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return controller.signal;
  };

  /**
   * Asks the other computer; HostForwarderError → its error answer. Refused at once while the
   * watcher reports the computer unreachable or `perHost` requests are open; the headers must come
   * within the deadline (the wait for a free connection counts).
   */
  const forward = async (
    hostId: HostId,
    request: UpstreamRequest,
    reply: FastifyReply,
  ): Promise<UpstreamResponse | ErrorPayload> => {
    const host = hosts.list().find((item) => item.hostId === hostId);
    if (host?.status === 'unreachable') {
      return sendError(
        reply,
        host.lastError?.code === 'HOST_UNREACHABLE'
          ? host.lastError
          : makeError('HOST_UNREACHABLE', { reason: 'unreachable' }),
      );
    }
    const open = inflight.get(hostId) ?? 0;
    if (open >= forwardLimits.perHost)
      return sendError(reply, makeError('HOST_UNREACHABLE', { reason: 'busy' }));
    inflight.set(hostId, open + 1);
    reply.raw.once('close', () => {
      const left = (inflight.get(hostId) ?? 1) - 1;
      if (left <= 0) inflight.delete(hostId);
      else inflight.set(hostId, left);
    });
    const deadline = new AbortController();
    const timer = setTimeout(
      () => {
        deadline.abort();
      },
      request.method === 'POST' ? forwardLimits.uploadHeadersMs : forwardLimits.headersMs,
    );
    const signal =
      request.signal === undefined ? deadline.signal : AbortSignal.any([request.signal, deadline.signal]);
    try {
      return await hosts.forwarder.request(hostId, { ...request, signal });
    } catch (error) {
      const failure = deadline.signal.aborted
        ? makeError('HOST_UNREACHABLE', { reason: 'timeout' })
        : forwardFailure(error);
      if (reply.raw.destroyed) return failure;
      return sendError(reply, failure);
    } finally {
      clearTimeout(timer);
    }
  };

  const isError = (value: UpstreamResponse | ErrorPayload): value is ErrorPayload => 'code' in value;

  /**
   * A 200 answer with content: this server's headers (policy `blob`, or `pdf` for a GET whose type
   * is application/pdf and whose bytes start with `%PDF-`), the checked body for GET.
   */
  const sendContent = async (
    request: FastifyRequest,
    reply: FastifyReply,
    response: UpstreamResponse,
    extra: { headers: Record<string, string>; sha256?: string },
  ): Promise<FastifyReply | ErrorPayload> => {
    const forwarded = forwardedMediaType(response.headers['content-type']);
    const mediaType = forwarded ?? DOWNLOAD_MEDIA_TYPE;
    const length = declaredLength(response, FORWARDED_BODY_MAX_BYTES);
    if (response.headers['content-length'] !== undefined && length === null) {
      response.body.destroy();
      return sendError(reply, makeError('HOST_UNREACHABLE', { reason: 'size' }));
    }
    let head: Buffer[] = [];
    let rest: AsyncIterator<unknown> | null = null;
    if (request.method !== 'HEAD') {
      rest = response.body[Symbol.asyncIterator]();
      try {
        head = await readHead(rest, PDF_MAGIC_BYTES);
      } catch {
        response.body.destroy();
        return sendError(reply, makeError('HOST_UNREACHABLE', { reason: 'closed' }));
      }
    }
    const pdf = mediaTypeEssence(mediaType) === 'application/pdf' && isPdf(Buffer.concat(head));
    // Written by hand (hijack): a body that fails its check must cut the transfer – Fastify's error
    // path would answer with the content headers (immutable caching) still set. Hence the whole
    // header set of the app's onSend hook is set here as well.
    const headers: Record<string, string> = {
      'content-type': mediaType,
      ...(length === null ? {} : { 'content-length': String(length) }),
      ...contentPolicyHeaders(pdf ? 'pdf' : 'blob'),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      ...extra.headers,
    };
    // Outside the closed set: never rendered under this origin, only saved (WP-75 §3.2).
    if (forwarded === null) {
      headers['content-disposition'] =
        extra.headers['content-disposition']?.replace(/^inline/, 'attachment') ?? 'attachment';
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, headers);
    if (rest === null) {
      response.body.destroy();
      res.end();
      return reply;
    }
    const body = checkedBody(head, rest, response.body, {
      maxBytes: FORWARDED_BODY_MAX_BYTES,
      length,
      ...(extra.sha256 === undefined ? {} : { sha256: extra.sha256 }),
    });
    // Minimum rate: a body that trickles is cut (the browser sees a broken transfer).
    let moved = 0;
    body.on('data', (chunk: Buffer) => {
      moved += chunk.length;
    });
    const watch = setInterval(() => {
      if (moved < forwardLimits.minBytesPerWindow) {
        log.warn({ moved }, 'forwarded body too slow – cut');
        // The generator behind `body` waits on the source: end the source, then the browser side.
        response.body.destroy(new ForwardedBodyError('slow'));
        res.destroy();
      }
      moved = 0;
    }, forwardLimits.windowMs);
    watch.unref();
    res.once('close', () => {
      clearInterval(watch);
    });
    pipeline(body, res, (error) => {
      if (error === null) return;
      // pipeline destroyed both ends: the browser sees a broken transfer, never a wrong body
      if (error instanceof ForwardedBodyError) log.warn({ reason: error.reason }, 'forwarded body rejected');
    });
    return reply;
  };

  await app.register(async (scope) => {
    scope.setErrorHandler(contentErrorHandler(log));

    // ---- window connections ----
    scope.route<{ Params: { hostId: string } }>({
      method: 'GET',
      url: HOST_API_PATHS.ws,
      // Second line (R1-01) as the hub's route: a rejected upgrade gets the HTTP error, never a 101.
      preValidation: (request, reply, done) => {
        const error = options.authorizeUpgrade(request);
        if (error !== null) {
          replyError(reply, error);
          return;
        }
        if (knownHost(request.params.hostId) === null) {
          replyError(reply, makeError('HOST_NOT_FOUND'));
          return;
        }
        done();
      },
      handler: (_request, reply) =>
        sendError(reply, makeError('INVALID_MESSAGE', { reason: 'upgrade_required' })),
      wsHandler: (socket, request) => {
        if (options.authorizeUpgrade(request) !== null) {
          log.error('unauthorized WebSocket reached the forwarder – terminated');
          socket.terminate();
          return;
        }
        const hostId = knownHost(request.params.hostId);
        if (hostId === null) {
          socket.close(WS_CLOSE.HOST_REVOKED, closeReason(WS_CLOSE.HOST_REVOKED));
          return;
        }
        sockets.add(socket);
        socket.once('close', () => {
          sockets.delete(socket);
        });
        bridgeWindow(socket, {
          connect: (signal) => hosts.forwarder.connectWindow(hostId, signal),
          limits: bridgeLimits,
          logger: log.child({ hostId }),
        });
      },
    });

    // ---- blob ----
    scope.route<{ Params: { hostId: string; blobId: string } }>({
      method: ['GET', 'HEAD'],
      url: HOST_API_PATHS.blob,
      handler: async (request, reply) => {
        const hostId = knownHost(request.params.hostId);
        if (hostId === null) return sendError(reply, makeError('HOST_NOT_FOUND'));
        const blobId = blobIdSchema.safeParse(request.params.blobId);
        if (!blobId.success) return sendError(reply, makeError('BLOB_NOT_FOUND'));
        const response = await forward(
          hostId,
          {
            method: request.method === 'HEAD' ? 'HEAD' : 'GET',
            path: REMOTE_PATHS.blob.replace(':blobId', blobId.data),
            query: '',
            headers: {},
            signal: abortOnClose(reply),
          },
          reply,
        );
        if (isError(response)) return response;
        if (response.status !== 200) return sendError(reply, await upstreamError(response, 'blob'));
        return sendContent(request, reply, response, {
          headers: { 'cache-control': 'private, max-age=31536000, immutable' },
          sha256: blobId.data,
        });
      },
    });

    // ---- file content ----
    scope.route<{ Params: { hostId: string }; Querystring: Record<string, unknown> }>({
      method: ['GET', 'HEAD'],
      url: HOST_API_PATHS.file,
      handler: async (request, reply) => {
        const hostId = knownHost(request.params.hostId);
        if (hostId === null) return sendError(reply, makeError('HOST_NOT_FOUND'));
        const query = fileQuerySchema.safeParse(request.query);
        if (!query.success) return sendError(reply, makeError('VALIDATION_FAILED', { reason: 'query' }));
        const response = await forward(
          hostId,
          {
            method: request.method === 'HEAD' ? 'HEAD' : 'GET',
            path: REMOTE_PATHS.file,
            query: new URLSearchParams({ entryId: query.data.entryId, path: query.data.path }).toString(),
            headers: {},
            signal: abortOnClose(reply),
          },
          reply,
        );
        if (isError(response)) return response;
        if (response.status !== 200) return sendError(reply, await upstreamError(response, 'file'));
        return sendContent(request, reply, response, {
          headers: {
            // WP-103: the path is the other computer's – its own shape tells whose rules name it.
            'content-disposition': inlineDisposition(
              pathRules(pathFlavorOfShape(query.data.path)).baseName(query.data.path),
            ),
            'cache-control': 'no-store',
          },
        });
      },
    });

    // ---- upload ----
    // Own scope: the body stays a stream (no buffering here), only the upload types have a parser
    // (any other type → 415); the length must be announced and within the local upload limit.
    await scope.register((upload, _opts, done) => {
      upload.removeAllContentTypeParsers();
      upload.addContentTypeParser([...UPLOAD_MEDIA_TYPES], (_request, payload, parsed) => {
        parsed(null, payload);
      });
      upload.post<{ Params: { hostId: string }; Querystring: Record<string, unknown> }>(
        HOST_API_PATHS.attachments,
        async (request, reply) => {
          const body = request.body;
          const stream = body instanceof Readable ? body : null;
          const drop = (error: ErrorPayload): ErrorPayload => {
            stream?.resume();
            return sendError(reply, error);
          };
          const hostId = knownHost(request.params.hostId);
          if (hostId === null) return drop(makeError('HOST_NOT_FOUND'));
          const query = attachmentUploadQuerySchema.safeParse(request.query);
          if (!query.success) return drop(makeError('VALIDATION_FAILED', { reason: 'query' }));
          const declared = uploadMediaTypeSchema.safeParse(mediaTypeEssence(request.headers['content-type']));
          if (stream === null || !declared.success) return drop(makeError('UNSUPPORTED_MEDIA_TYPE'));
          const lengthHeader = request.headers['content-length'];
          if (lengthHeader === undefined || !/^\d{1,12}$/u.test(lengthHeader)) {
            return drop(makeError('VALIDATION_FAILED', { reason: 'content_length' }));
          }
          if (Number(lengthHeader) > UPLOAD_BODY_LIMIT_BYTES) return drop(makeError('PAYLOAD_TOO_LARGE'));
          const params = new URLSearchParams();
          const { name, width, height } = query.data;
          if (name !== undefined) params.set('name', name);
          if (width !== undefined) params.set('width', String(width));
          if (height !== undefined) params.set('height', String(height));
          const response = await forward(
            hostId,
            {
              method: 'POST',
              path: REMOTE_PATHS.attachments,
              query: params.toString(),
              headers: { 'content-type': declared.data, 'content-length': String(Number(lengthHeader)) },
              body: stream,
              signal: abortOnClose(reply),
            },
            reply,
          );
          if (isError(response)) return response;
          if (response.status !== 200) return sendError(reply, await upstreamError(response, 'attachments'));
          const answer = attachmentUploadResponseSchema.safeParse(parseJson(await readSmall(response.body)));
          if (!answer.success) return sendError(reply, makeError('HOST_UNREACHABLE', { reason: 'answer' }));
          return answer.data;
        },
      );
      done();
    });
  });

  return {
    closeAll(code) {
      for (const socket of [...sockets]) socket.close(code, closeReason(code));
    },
    windowCount: () => sockets.size,
  };
}
