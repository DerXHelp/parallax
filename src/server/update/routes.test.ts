import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import {
  API_PATHS,
  changelogResponseSchema,
  noticesResponseSchema,
  updatePackageResponseSchema,
} from '@shared/http';
import { registerUpdateRoutes } from './routes';
import { createFakeUpdateService, type FakeUpdateService } from './testing';

const temps: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(
  maxBytes?: number,
): Promise<{ app: FastifyInstance; update: FakeUpdateService; dir: string }> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-routes-'));
  temps.push(dir);
  const update = createFakeUpdateService({ uploadDir: path.join(dir, 'downloads') });
  const app = Fastify();
  apps.push(app);
  await registerUpdateRoutes(app, update, maxBytes === undefined ? {} : { maxBytes });
  await app.ready();
  return { app, update, dir };
}

describe('POST /api/update/package', () => {
  it('streams the zip into uploadFile() and hands it over: 202', async () => {
    const { app, update } = await setup();
    const body = Buffer.from('PK\u0003\u0004 a zip');
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.updatePackage,
      headers: { 'content-type': 'application/zip' },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(updatePackageResponseSchema.parse(res.json())).toEqual({ accepted: true });
    expect(update.accepted).toHaveLength(1);
    expect(await readFile(update.accepted[0] ?? '')).toEqual(body);
  });

  it('accepts every zip media type, refuses others with 415', async () => {
    const { app, update } = await setup();
    for (const type of ['application/x-zip-compressed', 'application/octet-stream']) {
      const res = await app.inject({
        method: 'POST',
        url: API_PATHS.updatePackage,
        headers: { 'content-type': type },
        payload: Buffer.from('zip'),
      });
      expect(res.statusCode).toBe(202);
    }
    const json = await app.inject({ method: 'POST', url: API_PATHS.updatePackage, payload: { a: 1 } });
    expect(json.statusCode).toBe(415);
    expect(update.accepted).toHaveLength(2);
  });

  it('refuses while busy or without an installation before reading the body', async () => {
    const { app, update, dir } = await setup();
    update.setUploadIssue(makeError('UPDATE_BUSY', { status: 'downloading' }));
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.updatePackage,
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('zip'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(makeError('UPDATE_BUSY', { status: 'downloading' }));
    expect(res.headers.connection).toBe('close');
    update.setUploadIssue(makeError('UPDATE_NOT_PACKAGED'));
    const unsupported = await app.inject({
      method: 'POST',
      url: API_PATHS.updatePackage,
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.from('zip'),
    });
    expect(unsupported.json()).toEqual(makeError('UPDATE_NOT_PACKAGED'));
    expect(update.accepted).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('413 for a too large body (declared or counted); the file is deleted', async () => {
    const { app, update, dir } = await setup(10);
    const declared = await app.inject({
      method: 'POST',
      url: API_PATHS.updatePackage,
      headers: { 'content-type': 'application/zip', 'content-length': '11' },
      payload: Buffer.alloc(11),
    });
    expect(declared.statusCode).toBe(413);
    expect(declared.json()).toEqual(makeError('PAYLOAD_TOO_LARGE'));
    const counted = await app.inject({
      method: 'POST',
      url: API_PATHS.updatePackage,
      headers: { 'content-type': 'application/zip', 'transfer-encoding': 'chunked' },
      payload: Buffer.alloc(64),
    });
    expect(counted.statusCode).toBe(413);
    expect(update.accepted).toEqual([]);
    expect(await readdir(path.join(dir, 'downloads')).catch(() => [])).toEqual([]);
  });

  it('an empty body is no package', async () => {
    const { app, update } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: API_PATHS.updatePackage,
      headers: { 'content-type': 'application/zip' },
      payload: Buffer.alloc(0),
    });
    expect(res.json()).toEqual(makeError('UPDATE_INVALID_PACKAGE', { reason: 'zip' }));
    expect(update.accepted).toEqual([]);
  });
});

describe('GET /api/changelog and /api/notices', () => {
  it('validates the query and answers from the service', async () => {
    const { app, update } = await setup();
    update.setChangelog({
      version: '1.0.1',
      sections: [{ version: '1.0.1', date: '2026-11-28', body: '- Fix.' }],
    });
    const res = await app.inject({ method: 'GET', url: `${API_PATHS.changelog}?for=installed&since=1.0.0` });
    expect(res.statusCode).toBe(200);
    expect(changelogResponseSchema.parse(res.json()).sections).toHaveLength(1);
    expect(update.changelogQueries).toEqual([{ for: 'installed', since: '1.0.0' }]);

    for (const query of ['', '?for=everything', '?for=installed&since=..%5Cx']) {
      const bad = await app.inject({ method: 'GET', url: `${API_PATHS.changelog}${query}` });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual(makeError('VALIDATION_FAILED', { reason: 'query' }));
    }
    update.setChangelog(makeError('FILE_NOT_FOUND'));
    const missing = await app.inject({ method: 'GET', url: `${API_PATHS.changelog}?for=available` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(makeError('FILE_NOT_FOUND'));
  });

  it('serves the fixed notice files only', async () => {
    const { app, update } = await setup();
    const res = await app.inject({ method: 'GET', url: `${API_PATHS.notices}?file=license` });
    expect(noticesResponseSchema.parse(res.json())).toEqual({ file: 'license', text: 'license' });
    const bad = await app.inject({ method: 'GET', url: `${API_PATHS.notices}?file=..%5C..%5Csecret` });
    expect(bad.statusCode).toBe(400);
    update.setNotice(makeError('FILE_NOT_READABLE', { reason: 'busy' }));
    const busy = await app.inject({ method: 'GET', url: `${API_PATHS.notices}?file=third-party` });
    expect(busy.json()).toEqual(makeError('FILE_NOT_READABLE', { reason: 'busy' }));
    expect(update.noticeRequests).toEqual(['license', 'third-party']);
  });
});
