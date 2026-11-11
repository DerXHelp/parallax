import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError, type ErrorCode } from '@shared/errors';
import { BLOB_CSP, FILE_PDF_CSP, authCookieName, fileUrl } from '@shared/http';
import { settingsSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { createServerInstance } from '../config';
import { createRecordingOpener } from '../files/open';
import type { FileContent, FileContentProvider } from '../files/ports';
import { createFileService } from '../files/service';
import { entryLookup, fakeTranscripts } from '../files/testing';
import { createBlobStore, type FileBlobStore } from '../store/blobs';
import { CommandError } from '../sync/ports';
import { createApp, inlineDisposition } from './app';
import { createAuthService } from './auth';
import { makeTempHome } from './testServer';

const PORT = 4711;
const HOST = '127.0.0.1:4711';
const ORIGIN = 'http://127.0.0.1:4711';
const ENTRY = SAMPLE_IDS.entry;
const SECRET_TEXT = 'TOP-SECRET-CONTENT-4242';

interface Fixture {
  app: FastifyInstance;
  blobs: FileBlobStore;
  home: string;
  cookie: string;
  logs: string[];
  opened: string[];
}

let fixture: Fixture | null = null;

afterEach(async () => {
  await fixture?.app.close();
  await fixture?.blobs.close();
  fixture = null;
});

function content(body: Buffer, mediaType: string, name: string, policy: FileContent['policy']): FileContent {
  return { stream: Readable.from([body]), mediaType, bytes: body.length, name, policy };
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR'),
]);
const PDF = Buffer.from('%PDF-1.7\n%%EOF\n');

const FAILURES: readonly ErrorCode[] = [
  'FILE_NOT_FOUND',
  'PATH_NOT_ALLOWED',
  'PATH_REJECTED',
  'FILE_NOT_READABLE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'ENTRY_NOT_FOUND',
];

/** Fake provider: fixed answers per path, an error code for `C:\err\<CODE>`. */
function fakeFiles(opened: string[]): FileContentProvider {
  return {
    open: (entryId, file) => {
      opened.push(`${entryId} ${file}`);
      const code = FAILURES.find((candidate) => file === `C:\\err\\${candidate}`);
      if (code !== undefined) {
        return Promise.reject(
          new CommandError(makeError(code, code === 'PATH_REJECTED' ? { reason: 'unc' } : {})),
        );
      }
      switch (file) {
        case 'C:\\p\\a.txt':
          return Promise.resolve(
            content(Buffer.from(`hello\n${SECRET_TEXT}\n`), 'text/plain; charset=utf-8', 'a.txt', 'blob'),
          );
        case 'C:\\p\\img.png':
          return Promise.resolve(content(PNG, 'image/png', 'img.png', 'blob'));
        case 'C:\\p\\x.svg':
          return Promise.resolve(content(Buffer.from('<svg/>'), 'image/svg+xml', 'x.svg', 'blob'));
        case 'C:\\p\\doc.pdf':
          return Promise.resolve(content(PDF, 'application/pdf', 'doc.pdf', 'pdf'));
        case 'C:\\p\\odd.txt':
          return Promise.resolve(
            content(Buffer.from('x'), 'text/plain; charset=utf-8', 'ä b"c;d\r\n(1)*\'.txt', 'blob'),
          );
        default:
          return Promise.reject(new CommandError(makeError('FILE_NOT_FOUND')));
      }
    },
  };
}

async function setup(files: FileContentProvider | 'none' | 'fake' = 'fake'): Promise<Fixture> {
  const home = await makeTempHome('file-route-');
  const instance = createServerInstance({ serverVersion: '1.2.3' });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const blobs = createBlobStore({ home });
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = pino({ level: 'trace' }, sink);
  const opened: string[] = [];
  const provider = files === 'none' ? undefined : files === 'fake' ? fakeFiles(opened) : files;
  const app = await createApp({
    config: { port: PORT, dev: false },
    instance,
    auth,
    blobs,
    webRoot: null,
    logger,
    ...(provider === undefined ? {} : { files: provider }),
  });
  fixture = {
    app,
    blobs,
    home,
    cookie: `${authCookieName(PORT)}=${auth.createCookieValue()}`,
    logs,
    opened,
  };
  return fixture;
}

const goodHeaders = (f: Fixture): Record<string, string> => ({
  host: HOST,
  origin: ORIGIN,
  'sec-fetch-site': 'same-origin',
  cookie: f.cookie,
});

function get(f: Fixture, file: string, method: 'GET' | 'HEAD' = 'GET', headers?: Record<string, string>) {
  return f.app.inject({ method, url: fileUrl(ENTRY, file), headers: headers ?? goodHeaders(f) });
}

describe('GET/HEAD /api/file – guard class "file" (Sec-Fetch-Site × Origin × cookie)', () => {
  const sites = [undefined, 'same-origin', 'same-site', 'cross-site', 'none'] as const;
  const origins = [undefined, ORIGIN, 'http://evil.example'] as const;
  const cases = (['GET', 'HEAD'] as const).flatMap((method) =>
    sites.flatMap((site) =>
      origins.flatMap((origin) => [true, false].map((cookie) => [method, site, origin, cookie] as const)),
    ),
  );

  it('answers only same-origin requests with an allowed (or no) Origin and the cookie', async () => {
    const f = await setup();
    for (const [method, site, origin, cookie] of cases) {
      const headers: Record<string, string> = { host: HOST };
      if (site !== undefined) headers['sec-fetch-site'] = site;
      if (origin !== undefined) headers.origin = origin;
      if (cookie) headers.cookie = f.cookie;
      const res = await get(f, 'C:\\p\\a.txt', method, headers);
      const label = `${method} site=${String(site)} origin=${String(origin)} cookie=${String(cookie)}`;
      if (origin === 'http://evil.example') {
        expect([label, res.statusCode, res.json<{ params: unknown }>().params]).toEqual([
          label,
          403,
          { reason: 'origin' },
        ]);
      } else if (site !== 'same-origin') {
        expect([label, res.statusCode, res.json<{ params: unknown }>().params]).toEqual([
          label,
          403,
          { reason: 'sec-fetch-site' },
        ]);
      } else if (!cookie) {
        expect([label, res.statusCode]).toEqual([label, 401]);
      } else {
        expect([label, res.statusCode]).toEqual([label, 200]);
      }
    }
    // Only the accepted requests reached the file service.
    expect(f.opened.length).toBe(4);
  });
});

describe('GET/HEAD /api/file – answers', () => {
  it('text: UTF-8, no-store, inline filename*, CORP, sandbox CSP + DENY', async () => {
    const f = await setup();
    const res = await get(f, 'C:\\p\\a.txt');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`hello\n${SECRET_TEXT}\n`);
    expect(res.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(Buffer.byteLength(res.body)),
      'content-disposition': "inline; filename*=UTF-8''a.txt",
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': BLOB_CSP,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
    });
    expect(f.opened).toEqual([`${ENTRY} C:\\p\\a.txt`]);
  });

  it.each([
    ['C:\\p\\img.png', 'image/png', BLOB_CSP, 'DENY'],
    ['C:\\p\\x.svg', 'image/svg+xml', BLOB_CSP, 'DENY'],
    ['C:\\p\\doc.pdf', 'application/pdf', FILE_PDF_CSP, 'SAMEORIGIN'],
  ])('%s: %s with its header set', async (file, type, csp, frame) => {
    const f = await setup();
    const res = await get(f, file);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(type);
    expect(res.headers['content-security-policy']).toBe(csp);
    expect(res.headers['x-frame-options']).toBe(frame);
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('HEAD: the same headers, no body', async () => {
    const f = await setup();
    const res = await get(f, 'C:\\p\\doc.pdf', 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(res.headers['content-security-policy']).toBe(FILE_PDF_CSP);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('the file name is percent-encoded (no quote, CR/LF or ; in the header)', async () => {
    const f = await setup();
    const res = await get(f, 'C:\\p\\odd.txt');
    expect(res.headers['content-disposition']).toBe(
      "inline; filename*=UTF-8''%C3%A4%20b%22c%3Bd%0D%0A%281%29%2A%27.txt",
    );
    expect(inlineDisposition('')).toBe("inline; filename*=UTF-8''file");
  });

  it.each([
    ['FILE_NOT_FOUND', 404],
    ['PATH_NOT_ALLOWED', 403],
    ['PATH_REJECTED', 400],
    ['FILE_NOT_READABLE', 403],
    ['PAYLOAD_TOO_LARGE', 413],
    ['UNSUPPORTED_MEDIA_TYPE', 415],
    ['ENTRY_NOT_FOUND', 404],
  ] as const)('%s → %i with the ErrorPayload body', async (code, status) => {
    const f = await setup();
    const res = await get(f, `C:\\err\\${code}`);
    expect(res.statusCode).toBe(status);
    expect(res.json<{ code: string }>().code).toBe(code);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('400 VALIDATION_FAILED {reason: query} for a bad query; 501 without a file service', async () => {
    const f = await setup();
    for (const url of [
      '/api/file',
      '/api/file?entryId=x&path=C%3A%5Ca',
      `/api/file?entryId=${ENTRY}&path=`,
    ]) {
      const res = await f.app.inject({ method: 'GET', url, headers: goodHeaders(f) });
      expect([url, res.statusCode, res.json()]).toEqual([
        url,
        400,
        { code: 'VALIDATION_FAILED', params: { reason: 'query' } },
      ]);
    }
    await f.app.close();
    await f.blobs.close();
    const none = await setup('none');
    const res = await get(none, 'C:\\p\\a.txt');
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('never logs file content', async () => {
    const f = await setup();
    await get(f, 'C:\\p\\a.txt');
    await get(f, 'C:\\p\\a.txt', 'GET', { host: HOST, 'sec-fetch-site': 'cross-site', cookie: f.cookie });
    expect(f.logs.join('\n')).not.toContain(SECRET_TEXT);
  });
});

describe('GET /api/blob/:id – PDF header set (ADR-142)', () => {
  it('a blob with meta application/pdf and a %PDF- body gets FILE_PDF_CSP + SAMEORIGIN', async () => {
    const f = await setup();
    const pdf = f.blobs.put(PDF, 'application/pdf', 'doc.pdf');
    const fakePdf = f.blobs.put('<html>not a pdf</html>', 'application/pdf', 'fake.pdf');
    const pdfAsOctet = f.blobs.put(Buffer.concat([PDF, Buffer.from('x')]), 'application/octet-stream', null);
    const fetch = (blobId: string) =>
      f.app.inject({ method: 'GET', url: `/api/blob/${blobId}`, headers: goodHeaders(f) });

    const real = await fetch(pdf.blobId);
    expect(real.headers['content-security-policy']).toBe(FILE_PDF_CSP);
    expect(real.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(real.headers['content-type']).toBe('application/pdf');
    for (const other of [fakePdf.blobId, pdfAsOctet.blobId]) {
      const res = await fetch(other);
      expect(res.headers['content-security-policy']).toBe(BLOB_CSP);
      expect(res.headers['x-frame-options']).toBe('DENY');
    }
  });
});

describe('GET /api/file with the real file service', () => {
  it('serves a UTF-16 text file inside the cwd as UTF-8 and rejects paths outside', async () => {
    const f = await setup('none');
    await f.app.close();
    const cwd = path.join(f.home, 'project');
    await mkdir(cwd, { recursive: true });
    const file = path.join(cwd, 'notes.txt');
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße\r\n', 'utf16le')]));
    const service = createFileService({
      home: f.home,
      entries: entryLookup({ [ENTRY]: { cwd, additionalDirectories: [], conversationIds: [] } }),
      transcripts: fakeTranscripts(),
      settings: () => settingsSchema.parse({}),
      launcher: createRecordingOpener(),
    });
    const instance = createServerInstance({ serverVersion: '1.2.3' });
    const auth = await createAuthService({ home: f.home, serverInstanceId: instance.serverInstanceId });
    const app = await createApp({
      config: { port: PORT, dev: false },
      instance,
      auth,
      blobs: f.blobs,
      webRoot: null,
      files: service,
    });
    f.app = app;
    const headers = { ...goodHeaders(f), cookie: `${authCookieName(PORT)}=${auth.createCookieValue()}` };
    const res = await app.inject({ method: 'GET', url: fileUrl(ENTRY, file), headers });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('Grüße\r\n');
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    const outside = await app.inject({
      method: 'GET',
      url: fileUrl(ENTRY, path.join(f.home, 'x.txt')),
      headers,
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json()).toEqual({ code: 'PATH_NOT_ALLOWED', params: {} });
    const unc = await app.inject({ method: 'GET', url: fileUrl(ENTRY, '\\\\host\\share\\x.txt'), headers });
    expect(unc.statusCode).toBe(400);
    expect(unc.json()).toEqual({ code: 'PATH_REJECTED', params: { reason: 'unc' } });
    await service.flush();
  });
});
