import { describe, expect, it } from 'vitest';
import { checkRequest, classifyRequest, requestPath, type GuardResult } from './origin';

const PORT = 4711;
const HOST = '127.0.0.1:4711';
const ORIGIN = 'http://127.0.0.1:4711';

function check(method: string, url: string, headers: Record<string, string>, dev = false): GuardResult {
  return checkRequest({ method, url, headers: { host: HOST, ...headers } }, { port: PORT, dev });
}

const rejected = (reason: string) => ({ ok: false, error: { code: 'ORIGIN_REJECTED', params: { reason } } });

describe('classifyRequest', () => {
  it.each([
    ['GET', '/', 'static'],
    ['GET', '/assets/index-abc.js', 'static'],
    ['GET', '/api/health', 'public-get'],
    ['GET', '/api/auth/status?x=1', 'public-get'],
    ['GET', '/api/unknown', 'public-get'],
    ['GET', `/api/blob/${'a'.repeat(64)}`, 'blob'],
    ['POST', '/api/auth', 'auth-exchange'],
    ['POST', '/api/launcher/code', 'launcher'],
    ['GET', '/api/ws', 'ws'],
    ['POST', '/api/attachments', 'mutation'],
    ['PUT', '/api/auth', 'mutation'],
    ['OPTIONS', '/api/health', 'mutation'],
    ['DELETE', '/', 'mutation'],
  ])('%s %s → %s', (method, url, route) => {
    expect(classifyRequest(method, url)).toBe(route);
  });

  it('strips query and fragment', () => {
    expect(requestPath('/api/ws?token=x#y')).toBe('/api/ws');
  });
});

describe('checkRequest (architecture §5.1)', () => {
  it('requires an allowed Host for every request', () => {
    for (const host of ['localhost:4711', '127.0.0.1:4712', '127.0.0.1', 'evil.example']) {
      expect(
        checkRequest({ method: 'GET', url: '/', headers: { host } }, { port: PORT, dev: false }),
      ).toMatchObject({
        ok: false,
        error: { code: 'HOST_HEADER_REJECTED' },
      });
    }
    expect(checkRequest({ method: 'GET', url: '/', headers: {} }, { port: PORT, dev: false }).ok).toBe(false);
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
    expect(check('GET', '/api/health', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }).ok).toBe(true);
    expect(check('GET', '/api/health', { 'sec-fetch-site': 'none' }).ok).toBe(true);
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

  it('blob: like health, plus the cookie', () => {
    const url = `/api/blob/${'a'.repeat(64)}`;
    expect(check('GET', url, {})).toEqual({ ok: true, route: 'blob', needsCookie: true });
    expect(check('GET', url, { 'sec-fetch-site': 'cross-site' })).toMatchObject(rejected('sec-fetch-site'));
  });

  it('POST /api/auth: Origin and same-origin required, no cookie', () => {
    expect(check('POST', '/api/auth', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).toEqual({
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

  it('WS upgrade and other mutations: Origin + same-origin + cookie', () => {
    for (const [method, url] of [
      ['GET', '/api/ws'],
      ['POST', '/api/attachments'],
      ['DELETE', '/api/anything'],
    ] as const) {
      expect(check(method, url, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).toMatchObject({
        ok: true,
        needsCookie: true,
      });
      expect(check(method, url, {})).toMatchObject(rejected('origin'));
      expect(
        check(method, url, { origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'same-origin' }),
      ).toMatchObject(rejected('origin'));
      expect(check(method, url, { origin: ORIGIN, 'sec-fetch-site': 'same-site' })).toMatchObject(
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
    const vite = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin' };
    expect(check('GET', '/api/ws', vite, true).ok).toBe(true);
    expect(check('GET', '/api/ws', vite, false)).toMatchObject({
      ok: false,
      error: { code: 'HOST_HEADER_REJECTED' },
    });
    expect(check('GET', '/api/ws', { ...vite, host: HOST }, false)).toMatchObject(rejected('origin'));
  });
});
