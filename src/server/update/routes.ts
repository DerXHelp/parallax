/**
 * HTTP routes of the update (WP-87 §1.4, §2.1 "Routen"); wired by WP-89 (`http/app.ts`), guarded
 * there like every route (`origin.ts`: the upload class `mutation`, changelog and notices `file`).
 *
 * - `POST /api/update/package` ("Install from file"): an own Fastify scope whose only parser hands
 *   the raw body of `UPDATE_PACKAGE_MEDIA_TYPES` through as a stream (any other type: no parser,
 *   415). First `uploadIssue()` (409 UPDATE_BUSY / UPDATE_NOT_PACKAGED), then the body is streamed
 *   into `uploadFile()` – over `UPDATE_PACKAGE_MAX_BYTES` (declared or counted) → 413 and the file
 *   is deleted – then `acceptPackage` checks and stages it in the background: 202 `{accepted}`.
 *   Unlike the attachment upload nothing is held in memory.
 * - `GET /api/changelog`, `GET /api/notices`: query per zod, fixed files of the versions only (no
 *   path from the request); a `CommandError` answers with `ERROR_CATALOG[code].http`.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { makeError, type ErrorPayload } from '@shared/errors';
import {
  API_PATHS,
  UPDATE_PACKAGE_MAX_BYTES,
  UPDATE_PACKAGE_MEDIA_TYPES,
  changelogQuerySchema,
  noticesQuerySchema,
  type UpdatePackageResponse,
} from '@shared/http';
import { sendError } from '../http/reply';
import { CommandError } from '../sync/ports';
import type { UpdateService } from './ports';

export interface UpdateRoutesOptions {
  /** Test seam (default `UPDATE_PACKAGE_MAX_BYTES`). */
  maxBytes?: number;
}

type Query = Record<string, unknown>;

/** An early answer of the upload: the connection closes after it (the rest of the body is not read). */
function refuseUpload(reply: FastifyReply, error: ErrorPayload): ErrorPayload {
  void reply.header('connection', 'close');
  return sendError(reply, error);
}

class TooLargeError extends Error {
  constructor() {
    super('update package too large');
    this.name = 'TooLargeError';
  }
}

/** Passes chunks through and fails as soon as more than `maxBytes` went by. */
function byteLimit(maxBytes: number): Transform & { bytes: () => number } {
  let bytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new TooLargeError());
      else callback(null, chunk);
    },
  });
  return Object.assign(transform, { bytes: () => bytes });
}

export async function registerUpdateRoutes(
  app: FastifyInstance,
  update: UpdateService,
  options: UpdateRoutesOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? UPDATE_PACKAGE_MAX_BYTES;

  app.get<{ Querystring: Query }>(API_PATHS.changelog, async (request, reply) => {
    const query = changelogQuerySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, makeError('VALIDATION_FAILED', { reason: 'query' }));
    try {
      return await update.changelog(query.data);
    } catch (error) {
      if (error instanceof CommandError) return sendError(reply, error.error);
      throw error;
    }
  });

  app.get<{ Querystring: Query }>(API_PATHS.notices, async (request, reply) => {
    const query = noticesQuerySchema.safeParse(request.query);
    if (!query.success) return sendError(reply, makeError('VALIDATION_FAILED', { reason: 'query' }));
    try {
      return await update.notice(query.data.file);
    } catch (error) {
      if (error instanceof CommandError) return sendError(reply, error.error);
      throw error;
    }
  });

  await app.register((scope, _opts, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser([...UPDATE_PACKAGE_MEDIA_TYPES], (_request, payload, parsed) => {
      parsed(null, payload);
    });
    scope.post(API_PATHS.updatePackage, async (request, reply) => {
      const issue = update.uploadIssue();
      if (issue !== null) return refuseUpload(reply, issue);
      const body: unknown = request.body;
      if (!(body instanceof Readable)) return refuseUpload(reply, makeError('UNSUPPORTED_MEDIA_TYPE'));
      const declared = Number(request.headers['content-length'] ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        return refuseUpload(reply, makeError('PAYLOAD_TOO_LARGE'));
      }
      let file: string;
      try {
        file = update.uploadFile();
      } catch (error) {
        if (error instanceof CommandError) return refuseUpload(reply, error.error);
        throw error;
      }
      const limit = byteLimit(maxBytes);
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await pipeline(body, limit, createWriteStream(file, { flags: 'wx' }));
      } catch (error) {
        await rm(file, { force: true }).catch(() => undefined);
        if (error instanceof TooLargeError) return refuseUpload(reply, makeError('PAYLOAD_TOO_LARGE'));
        request.log.warn({ err: error }, 'update package upload failed');
        return refuseUpload(reply, makeError('UPDATE_DOWNLOAD_FAILED', { reason: 'disk' }));
      }
      if (limit.bytes() === 0) {
        await rm(file, { force: true }).catch(() => undefined);
        return sendError(reply, makeError('UPDATE_INVALID_PACKAGE', { reason: 'zip' }));
      }
      update.acceptPackage(file);
      const response: UpdatePackageResponse = { accepted: true };
      return reply.code(202).send(response);
    });
    done();
  });
}
