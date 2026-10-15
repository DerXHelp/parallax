import { describe, expect, it } from 'vitest';
import { API_PATHS } from '@shared/http';
import {
  STATIC_ROUTE,
  checkRequest,
  classifyRequest,
  isApiRoute,
  requestPath,
  type GuardRequest,
  type GuardResult,
} from './origin';

const PORT = 4711;
const HOST = '127.0.0.1:4711';
const ORIGIN = 'http://127.0.0.1:4711';
const BLOB_URL = `/api/blob/${'a'.repeat(64)}`;
const API_ROUTES: readonly string[] = Object.values(API_PATHS);

/** Route pattern Fastify would match for the canonical URL (tests pass it explicitly otherwise). */
function routeOf(url: string): string | null {
  const path = requestPath(url);
  if (path.startsWith('/api/blob/')) return API_PATHS.blob;
  if (API_ROUTES.includes(path)) return path;
  return path.startsWith('/api/') ? null : STATIC_ROUTE;
}

function check(
  method: string,
  url: string,
  headers: Record<string, string>,
  options: { dev?: boolean; route?: string | null; upgrade?: boolean } = {},
): GuardResult {
  const request: GuardRequest = {
    method,
    url,
    route: options.route === undefined ? routeOf(url) : options.route,
    upgrade: options.upgrade ?? false,
    headers: { host: HOST, ...headers },
  };
  return checkRequest(request, { port: PORT, dev: options.dev ?? false });
}

const rejected = (reason: string) => ({ ok: false, error: { code: 'ORIGIN_REJECTED', params: { reason } } });
const badTarget = { ok: false, error: { code: 'VALIDATION_FAILED', params: { reason: 'request_target' } } };
const notUpgradable = {
  ok: false,
  error: { code: 'INVALID_MESSAGE', params: { reason: 'upgrade_not_allowed' } },
};
const sameOrigin = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

describe('classifyRequest (by matched route pattern, default-deny)', () => {
  it.each([
    ['GET', STATIC_ROUTE, 'static'],
    ['HEAD', STATIC_ROUTE, 'static'],
    ['GET', API_PATHS.health, 'public-get'],
    ['HEAD', API_PATHS.health, 'public-get'],
    ['GET', API_PATHS.authStatus, 'public-get'],
    ['GET', API_PATHS.blob, 'blob'],
    ['HEAD', API_PATHS.blob, 'blob'],
    ['POST', API_PATHS.auth, 'auth-exchange'],
    ['POST', API_PATHS.launcherCode, 'launcher'],
    ['GET', API_PATHS.ws, 'ws'],
    ['HEAD', API_PATHS.ws, 'ws'],
    ['POST', API_PATHS.attachments, 'mutation'],
    ['PUT', API_PATHS.auth, 'mutation'],
    ['GET', API_PATHS.auth, 'mutation'],
    ['GET', API_PATHS.launcherCode, 'mutation'],
    ['POST', API_PATHS.health, 'mutation'],
    ['DELETE', STATIC_ROUTE, 'mutation'],
    // a future route that is not in the table is protected automatically (e.g. GET /api/file)
    ['GET', '/api/file', 'mutation'],
    ['GET', '/api/blob/:blobId/raw', 'mutation'],
    ['GET', null, 'not-found'],
    ['HEAD', null, 'not-found'],
    ['POST', null, 'mutation'],
    ['OPTIONS', null, 'mutation'],
  ] as const)('%s %s → %s', (method, route, expected) => {
    expect(classifyRequest(method, route)).toBe(expected);
  });

  it('knows API routes and strips query/fragment for logs', () => {
    expect(isApiRoute(API_PATHS.blob)).toBe(true);
    expect(isApiRoute(STATIC_ROUTE)).toBe(false);
    expect(isApiRoute(null)).toBe(false);
    expect(isApiRoute('/apix')).toBe(false);
    expect(requestPath('/api/ws?token=x#y')).toBe('/api/ws');
  });
});

describe('checkRequest (architecture §5.1)', () => {
  it('requires an allowed Host for every request', () => {
    for (const host of ['localhost:4711', '127.0.0.1:4712', '127.0.0.1', 'evil.example']) {
      expect(check('GET', '/', { host })).toMatchObject({
        ok: false,
        error: { code: 'HOST_HEADER_REJECTED' },
      });
    }
    const noHost = checkRequest(
      { method: 'GET', url: '/', route: STATIC_ROUTE, upgrade: false, headers: {} },
      { port: PORT, dev: false },
    );
    expect(noHost.ok).toBe(false);
  });

  it('static pages need nothing but the Host', () => {
    expect(check('GET', '/', { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })).toEqual({
      ok: true,
      route: 'static',
      needsCookie: false,
    });
  });

  it('health/status: Origin and Sec-Fetch-Site only checked when present', () => {
    expect(check('GET', '/api/health', {})).toMatchObject({ ok: true, needsCookie: false });
    expect(check('HEAD', '/api/health', {})).toMatchObject({ ok: true, needsCookie: false });
    expect(check('GET', '/api/health', sameOrigin).ok).toBe(true);
    expect(check('GET', '/api/health', { 'sec-fetch-site': 'none' }).ok).toBe(true);
    expect(check('GET', '/api/auth/status?x=1', {}).ok).toBe(true);
    expect(check('GET', '/api/auth/status', { origin: 'http://evil.example' })).toMatchObject(
      rejected('origin'),
    );
    expect(check('GET', '/api/auth/status', { origin: 'null' })).toMatchObject(rejected('origin-null'));
    expect(check('GET', '/api/auth/status', { 'sec-fetch-site': 'same-site' })).toMatchObject(
      rejected('sec-fetch-site'),
    );
    expect(check('GET', '/api/auth/status', { 'sec-fetch-site': 'cross-site' })).toMatchObject(
      rejected('sec-fetch-site'),
    );
  });

  it('unmatched GET/HEAD (404) follows the public-get rules, without cookie', () => {
    expect(check('GET', '/api/nope', {}, { route: null })).toEqual({
      ok: true,
      route: 'not-found',
      needsCookie: false,
    });
    expect(check('GET', '/api/nope', { 'sec-fetch-site': 'cross-site' }, { route: null })).toMatchObject(
      rejected('sec-fetch-site'),
    );
  });

  it('blob: like health, plus the cookie (GET and HEAD)', () => {
    expect(check('GET', BLOB_URL, {})).toEqual({ ok: true, route: 'blob', needsCookie: true });
    expect(check('HEAD', BLOB_URL, {})).toEqual({ ok: true, route: 'blob', needsCookie: true });
    expect(check('GET', BLOB_URL, { 'sec-fetch-site': 'cross-site' })).toMatchObject(
      rejected('sec-fetch-site'),
    );
  });

  it('POST /api/auth: Origin and same-origin required, no cookie', () => {
    expect(check('POST', '/api/auth', sameOrigin)).toEqual({
      ok: true,
      route: 'auth-exchange',
      needsCookie: false,
    });
    expect(check('POST', '/api/auth', { 'sec-fetch-site': 'same-origin' })).toMatchObject(rejected('origin'));
    expect(check('POST', '/api/auth', { origin: ORIGIN })).toMatchObject(rejected('sec-fetch-site'));
    expect(check('POST', '/api/auth', { origin: ORIGIN, 'sec-fetch-site': 'none' })).toMatchObject(
      rejected('sec-fetch-site'),
    );
    expect(check('POST', '/api/auth', { origin: 'null', 'sec-fetch-site': 'same-origin' })).toMatchObject(
      rejected('origin-null'),
    );
  });

  describe('WebSocket upgrade (V1-01): Origin + Host + cookie, Sec-Fetch-Site only if present', () => {
    const ws = (headers: Record<string, string>) => check('GET', '/api/ws', headers, { upgrade: true });

    it('accepts the own origin without Sec-Fetch-Site (Chrome/Edge send none)', () => {
      expect(ws({ origin: ORIGIN })).toEqual({ ok: true, route: 'ws', needsCookie: true });
    });

    it('accepts Sec-Fetch-Site same-origin', () => {
      expect(ws(sameOrigin)).toEqual({ ok: true, route: 'ws', needsCookie: true });
    });

    it.each(['cross-site', 'same-site', 'none', 'garbage'])('rejects a present Sec-Fetch-Site %s', (site) => {
      expect(ws({ origin: ORIGIN, 'sec-fetch-site': site })).toMatchObject(rejected('sec-fetch-site'));
    });

    it('still requires an allowed Origin', () => {
      expect(ws({})).toMatchObject(rejected('origin'));
      expect(ws({ 'sec-fetch-site': 'same-origin' })).toMatchObject(rejected('origin'));
      expect(ws({ origin: 'http://evil.example' })).toMatchObject(rejected('origin'));
      expect(ws({ origin: 'http://127.0.0.1:9999' })).toMatchObject(rejected('origin'));
      expect(ws({ origin: 'null' })).toMatchObject(rejected('origin-null'));
    });
  });

  it('other mutations (non-GET) keep Origin + same-origin + cookie', () => {
    for (const [method, url, route] of [
      ['POST', '/api/attachments', API_PATHS.attachments],
      ['DELETE', '/api/anything', null],
      ['GET', '/api/file', '/api/file'],
    ] as const) {
      expect(check(method, url, sameOrigin, { route })).toMatchObject({ ok: true, needsCookie: true });
      expect(check(method, url, {}, { route })).toMatchObject(rejected('origin'));
      expect(check(method, url, { origin: ORIGIN }, { route })).toMatchObject(rejected('sec-fetch-site'));
      expect(
        check(method, url, { origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'same-origin' }, { route }),
      ).toMatchObject(rejected('origin'));
      expect(check(method, url, { origin: ORIGIN, 'sec-fetch-site': 'same-site' }, { route })).toMatchObject(
        rejected('sec-fetch-site'),
      );
    }
  });

  it('launcher: Origin must be absent, Sec-Fetch-Site absent or none', () => {
    expect(check('POST', '/api/launcher/code', {})).toEqual({
      ok: true,
      route: 'launcher',
      needsCookie: false,
    });
    expect(check('POST', '/api/launcher/code', { 'sec-fetch-site': 'none' }).ok).toBe(true);
    expect(check('POST', '/api/launcher/code', { origin: ORIGIN })).toMatchObject(rejected('origin'));
    expect(check('POST', '/api/launcher/code', { origin: 'null' })).toMatchObject(rejected('origin-null'));
    expect(check('POST', '/api/launcher/code', { 'sec-fetch-site': 'same-origin' })).toMatchObject(
      rejected('sec-fetch-site'),
    );
  });

  it('dev mode additionally allows the Vite host and origin (5173)', () => {
    const vite = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' };
    expect(check('GET', '/api/ws', vite, { dev: true, upgrade: true }).ok).toBe(true);
    expect(check('GET', '/api/ws', vite, { upgrade: true })).toMatchObject({
      ok: false,
      error: { code: 'HOST_HEADER_REJECTED' },
    });
    expect(check('GET', '/api/ws', { ...vite, host: HOST }, { upgrade: true })).toMatchObject(
      rejected('origin'),
    );
  });
});

describe('request target and upgrade rules (R1-01, before the table)', () => {
  it.each([
    // percent-encoding on an API route (find-my-way decodes it before matching)
    ['/%61pi/ws', API_PATHS.ws],
    ['/api/%77s', API_PATHS.ws],
    ['/api/%57S', API_PATHS.ws],
    ['/api/%62lob/' + 'a'.repeat(64), API_PATHS.blob],
    ['/%61pi/blob/' + 'a'.repeat(64), API_PATHS.blob],
    ['/api/blob/%61' + 'a'.repeat(63), API_PATHS.blob],
    ['/api/health%3F', API_PATHS.health],
    // other non-canonical API paths a router might still map
    ['/api/ws;x', API_PATHS.ws],
    ['/api/ws/', API_PATHS.ws],
    ['//api/ws', API_PATHS.ws],
    ['/api/./ws', API_PATHS.ws],
    ['/api/x/../ws', API_PATHS.ws],
    ['/api/ws#frag', API_PATHS.ws],
    // absolute and asterisk form (never sent by a browser to a non-proxy)
    ['http://127.0.0.1:4711/api/ws', API_PATHS.ws],
    ['http://127.0.0.1:4711/api/blob/' + 'a'.repeat(64), API_PATHS.blob],
    ['http://127.0.0.1:4711/', STATIC_ROUTE],
    ['*', null],
  ])('rejects %s with 400 request_target', (url, route) => {
    // even with every header a legitimate same-origin request would carry
    expect(check('GET', url, sameOrigin, { route })).toMatchObject(badTarget);
    expect(check('GET', url, { origin: 'http://evil.example' }, { route, upgrade: true })).toMatchObject(
      badTarget,
    );
  });

  it('allows a query string on canonical API paths and any origin-form path on the static route', () => {
    expect(check('GET', '/api/auth/status?ts=1%20', {}).ok).toBe(true);
    expect(check('GET', '/assets/a%20b.js', {}, { route: STATIC_ROUTE }).ok).toBe(true);
    expect(check('GET', '/%61pi/ws', {}, { route: STATIC_ROUTE }).ok).toBe(true);
  });

  it.each([
    ['static route', '/API/ws', STATIC_ROUTE],
    ['404', '/API/ws', null],
    ['health', '/api/health', API_PATHS.health],
    ['blob', BLOB_URL, API_PATHS.blob],
    ['auth', '/api/auth', API_PATHS.auth],
  ])('refuses a WebSocket upgrade on the %s route', (_name, url, route) => {
    expect(check('GET', url, sameOrigin, { route, upgrade: true })).toMatchObject(notUpgradable);
  });
});
