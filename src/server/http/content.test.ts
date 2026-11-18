import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, type BlobId } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  API_PATHS,
  BLOB_CSP,
  FILE_PDF_CSP,
  REMOTE_PATHS,
  attachmentUploadResponseSchema,
  authCookieName,
  pageCsp,
} from '@shared/http';
import type { BlobRef } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { createServerInstance } from '../config';
import type { FileContent, FileContentProvider } from '../files/ports';
import { CommandError, type BlobStore } from '../sync/ports';
import { createApp } from './app';
import { createAuthService } from './auth';
import { registerContentRoutes, type ContentRoutePaths, type ContentRoutesOptions } from './content';
import { makeTempHome } from './testServer';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-content'),
]);
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');
const ENTRY = SAMPLE_IDS.entry;
const SILENT = pino({ level: 'silent' });

/** In-memory BlobStore (content-addressed like store/blobs.ts) that records every put. */
class MemoryBlobs implements BlobStore {
  readonly stored = new Map<string, { data: Uint8Array; ref: BlobRef }>();
  puts = 0;

  put(
    data: Uint8Array | string,
    mediaType: string,
    name?: string | null,
    size?: { width: number; height: number } | null,
  ): BlobRef {
    this.puts += 1;
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const ref: BlobRef = {
      blobId: createHash('sha256').update(bytes).digest('hex'),
      mediaType,
      bytes: bytes.byteLength,
      width: size?.width ?? null,
      height: size?.height ?? null,
      name: name ?? null,
    };
    this.stored.set(ref.blobId, { data: bytes, ref });
    return ref;
  }

  get(blobId: BlobId): Promise<{ data: Uint8Array; ref: BlobRef } | null> {
    return Promise.resolve(this.stored.get(blobId) ?? null);
  }
}

/** A file service that answers one fixed content and counts the opened streams. */
function fileProvider(body: Buffer, policy: FileContent['policy'] = 'blob') {
  const streams: Readable[] = [];
  const provider: FileContentProvider & { streams: Readable[]; opens: number } = {
    streams,
    opens: 0,
    open: (_entryId, path) => {
      provider.opens += 1;
      if (path.endsWith('missing.txt')) return Promise.reject(new CommandError(makeError('FILE_NOT_FOUND')));
      const stream = Readable.from([body]);
      streams.push(stream);
      return Promise.resolve({
        stream,
        mediaType: policy === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
        bytes: body.length,
        name: policy === 'pdf' ? 'plan.pdf' : 'notes "1".txt',
        policy,
      });
    },
  };
  return provider;
}

const OTHER_PATHS: ContentRoutePaths = {
  blob: '/other/v9/blob/:blobId',
  file: '/other/v9/file',
  attachments: '/other/v9/attachments',
};

let apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});

/** A bare instance (no guard, no own hooks) with only the content routes – like the remote listener. */
async function bare(options: Partial<ContentRoutesOptions> & { blobs?: MemoryBlobs } = {}) {
  const blobs = options.blobs ?? new MemoryBlobs();
  const app = fastify();
  apps.push(app);
  await registerContentRoutes(app, { paths: OTHER_PATHS, logger: SILENT, ...options, blobs });
  return { app, blobs };
}

function fileUrlOf(paths: ContentRoutePaths, path: string): string {
  return `${paths.file}?entryId=${encodeURIComponent(ENTRY)}&path=${encodeURIComponent(path)}`;
}

function blobUrlOf(paths: ContentRoutePaths, blobId: string): string {
  return paths.blob.replace(':blobId', blobId);
}

describe('content routes under other paths (WP-78b)', () => {
  it('serves blobs with the content header policy – also on an instance without own hooks', async () => {
    const blobs = new MemoryBlobs();
    const png = blobs.put(PNG, 'image/png', 'shot.png');
    const pdf = blobs.put(PDF, 'application/pdf', 'doc.pdf');
    const odd = blobs.put('x', 'text/html\r\nx-injected: 1');
    const { app } = await bare({ blobs });

    const res = await app.inject({ method: 'GET', url: blobUrlOf(OTHER_PATHS, png.blobId) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'content-security-policy': BLOB_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, max-age=31536000, immutable',
    });

    const pdfRes = await app.inject({ method: 'GET', url: blobUrlOf(OTHER_PATHS, pdf.blobId) });
    expect(pdfRes.headers['content-security-policy']).toBe(FILE_PDF_CSP);
    expect(pdfRes.headers['x-frame-options']).toBe('SAMEORIGIN');

    const oddRes = await app.inject({ method: 'GET', url: blobUrlOf(OTHER_PATHS, odd.blobId) });
    expect(oddRes.headers['content-type']).toBe('application/octet-stream');
    expect(oddRes.headers['x-injected']).toBeUndefined();

    // The local paths do not exist on this instance.
    const local = await app.inject({ method: 'GET', url: `/api/blob/${png.blobId}` });
    expect(local.statusCode).toBe(404);
  });

  it('serves file content (GET and HEAD) with disposition, policy and nosniff', async () => {
    const files = fileProvider(Buffer.from('hello'));
    const { app } = await bare({ files });

    const res = await app.inject({ method: 'GET', url: fileUrlOf(OTHER_PATHS, 'C:\\work\\notes.txt') });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello');
    expect(res.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-length': '5',
      'content-disposition': "inline; filename*=UTF-8''notes%20%221%22.txt",
      'content-security-policy': BLOB_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });

    const head = await app.inject({ method: 'HEAD', url: fileUrlOf(OTHER_PATHS, 'C:\\work\\notes.txt') });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe('5');
    expect(files.streams.every((stream) => stream.destroyed)).toBe(true);

    const pdf = await bare({ files: fileProvider(PDF, 'pdf') });
    const pdfRes = await pdf.app.inject({ method: 'GET', url: fileUrlOf(OTHER_PATHS, 'C:\\work\\plan.pdf') });
    expect(pdfRes.headers['content-security-policy']).toBe(FILE_PDF_CSP);
    expect(pdfRes.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('answers errors as ErrorPayload with catalog status, also for body limit and media type', async () => {
    const files = fileProvider(Buffer.from('hello'));
    const { app } = await bare({ files });

    const missing = await app.inject({ method: 'GET', url: fileUrlOf(OTHER_PATHS, 'C:\\work\\missing.txt') });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(missing.headers).toMatchObject({
      'content-security-policy': BLOB_CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });

    const badQuery = await app.inject({ method: 'GET', url: `${OTHER_PATHS.file}?path=x` });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json()).toMatchObject({ code: 'VALIDATION_FAILED', params: { reason: 'query' } });

    const badBlob = await app.inject({ method: 'GET', url: blobUrlOf(OTHER_PATHS, 'nope') });
    expect(badBlob.statusCode).toBe(404);
    expect(badBlob.json()).toMatchObject({ code: 'BLOB_NOT_FOUND' });

    const text = await app.inject({
      method: 'POST',
      url: OTHER_PATHS.attachments,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });

    const huge = await app.inject({
      method: 'POST',
      url: `${OTHER_PATHS.attachments}?name=big.bin`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(Math.max(LIMITS.imageBytes, LIMITS.pdfBytes, LIMITS.fileAttachmentBytes) + 1),
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

    const noService = await bare();
    const unavailable = await noService.app.inject({
      method: 'GET',
      url: fileUrlOf(OTHER_PATHS, 'C:\\a.txt'),
    });
    expect(unavailable.statusCode).toBe(501);
  });

  it('stores an upload under the other path and answers its BlobRef', async () => {
    const { app, blobs } = await bare();
    const res = await app.inject({
      method: 'POST',
      url: `${OTHER_PATHS.attachments}?name=shot.png&width=10&height=20`,
      headers: { 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(res.statusCode).toBe(200);
    const { attachment } = attachmentUploadResponseSchema.parse(res.json());
    expect(attachment).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, width: 10, height: 20 });
    expect(blobs.stored.has(attachment.blobId)).toBe(true);
  });

  it('registers under REMOTE_PATHS as the remote listener will', async () => {
    const blobs = new MemoryBlobs();
    const ref = blobs.put(PNG, 'image/png');
    const app = fastify();
    apps.push(app);
    await registerContentRoutes(app, {
      paths: REMOTE_PATHS,
      blobs,
      logger: SILENT,
      beforeEffect: () => true,
    });
    const res = await app.inject({ method: 'GET', url: blobUrlOf(REMOTE_PATHS, ref.blobId) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses a blob path without :blobId', async () => {
    const app = fastify();
    apps.push(app);
    await expect(
      registerContentRoutes(app, {
        paths: { ...OTHER_PATHS, blob: '/other/blob' },
        blobs: new MemoryBlobs(),
        logger: SILENT,
      }),
    ).rejects.toThrow(/:blobId/);
  });
});

describe('beforeEffect (remote access: the coupling must still hold, WP-76 §B.8)', () => {
  it('false before the request: 403 HOST_REVOKED, the file service and the store are never asked', async () => {
    const blobs = new MemoryBlobs();
    const ref = blobs.put(PNG, 'image/png');
    const files = fileProvider(Buffer.from('secret'));
    const seen: FastifyRequest[] = [];
    const { app } = await bare({
      blobs,
      files,
      beforeEffect: (request) => {
        seen.push(request);
        return false;
      },
    });
    blobs.puts = 0;

    const blob = await app.inject({ method: 'GET', url: blobUrlOf(OTHER_PATHS, ref.blobId) });
    expect(blob.statusCode).toBe(403);
    expect(blob.json()).toMatchObject({ code: 'HOST_REVOKED' });
    expect(blob.rawPayload.includes(PNG)).toBe(false);

    const file = await app.inject({ method: 'GET', url: fileUrlOf(OTHER_PATHS, 'C:\\work\\notes.txt') });
    expect(file.statusCode).toBe(403);
    expect(file.body).not.toContain('secret');
    expect(files.opens).toBe(0);

    const upload = await app.inject({
      method: 'POST',
      url: `${OTHER_PATHS.attachments}?name=shot.png`,
      headers: { 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(upload.statusCode).toBe(403);
    expect(blobs.puts).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it('a coupling revoked while the file is opened: nothing delivered, the stream is closed', async () => {
    let valid = true;
    const files = fileProvider(Buffer.from('secret'));
    const open = files.open.bind(files);
    files.open = async (entryId, path) => {
      const content = await open(entryId, path);
      valid = false; // unpaired while the file service worked
      return content;
    };
    const { app } = await bare({ files, beforeEffect: () => valid });
    const res = await app.inject({ method: 'GET', url: fileUrlOf(OTHER_PATHS, 'C:\\work\\notes.txt') });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'HOST_REVOKED' });
    expect(res.body).not.toContain('secret');
    expect(files.streams[0]?.destroyed).toBe(true);
  });

  it('a coupling revoked while the blob is read: nothing delivered', async () => {
    let valid = true;
    const blobs = new MemoryBlobs();
    const ref = blobs.put(PNG, 'image/png');
    const get = blobs.get.bind(blobs);
    blobs.get = async (blobId) => {
      const found = await get(blobId);
      valid = false;
      return found;
    };
    const { app } = await bare({ blobs, beforeEffect: () => valid });
    const res = await app.inject({ method: 'GET', url: blobUrlOf(OTHER_PATHS, ref.blobId) });
    expect(res.statusCode).toBe(403);
    expect(res.rawPayload.includes(PNG)).toBe(false);
  });

  it('a coupling revoked while the upload body arrives: nothing stored', async () => {
    const answers = [true, false];
    const blobs = new MemoryBlobs();
    const { app } = await bare({ blobs, beforeEffect: () => answers.shift() ?? false });
    const res = await app.inject({
      method: 'POST',
      url: `${OTHER_PATHS.attachments}?name=shot.png`,
      headers: { 'content-type': 'image/png' },
      payload: PNG,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'HOST_REVOKED' });
    expect(blobs.puts).toBe(0);
    expect(answers).toEqual([]);
  });
});

describe('the local app keeps its behaviour with the extracted routes', () => {
  it('content error answers still get the page CSP of the app hook (the app hook runs first)', async () => {
    const PORT = 4711;
    const home = await makeTempHome('content-');
    const instance = createServerInstance({ serverVersion: '1.2.3' });
    const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
    const blobs = new MemoryBlobs();
    const ref = blobs.put(PNG, 'image/png');
    const app = await createApp({ config: { port: PORT, dev: false }, instance, auth, blobs, webRoot: null });
    apps.push(app);
    const headers = {
      host: `127.0.0.1:${String(PORT)}`,
      cookie: `${authCookieName(PORT)}=${auth.createCookieValue()}`,
    };

    const missing = await app.inject({ method: 'GET', url: blobUrlOf(API_PATHS, '0'.repeat(64)), headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-security-policy']).toBe(pageCsp(PORT));
    expect(missing.headers['cross-origin-opener-policy']).toBe('same-origin');

    const found = await app.inject({ method: 'GET', url: blobUrlOf(API_PATHS, ref.blobId), headers });
    expect(found.statusCode).toBe(200);
    expect(found.headers['content-security-policy']).toBe(BLOB_CSP);
    expect(found.headers['x-content-type-options']).toBe('nosniff');

    // Without the cookie the guard answers before the route (the content routes add no own guard).
    const anonymous = await app.inject({
      method: 'GET',
      url: blobUrlOf(API_PATHS, ref.blobId),
      headers: { host: headers.host },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
