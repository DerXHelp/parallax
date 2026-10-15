import { describe, expect, it, vi } from 'vitest';
import { API_PATHS } from '@shared/http';
import { sampleAuthStatus, sampleToken } from '@shared/samples';
import { consumeAuthCode, createAuthBootstrap, type FetchLike } from './auth';

const CODE = sampleToken(7);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, init });
    const handler = handlers[url];
    if (handler === undefined) return Promise.reject(new TypeError('network error'));
    return Promise.resolve(handler());
  };
  return { calls, fetchFn };
}

describe('consumeAuthCode', () => {
  it('takes the code out of the URL at once and keeps the rest of the hash', () => {
    const replaceState = vi.fn();
    const code = consumeAuthCode(
      { hash: `#code=${CODE}&session=local:en_00000000000000000000000000000001`, pathname: '/', search: '' },
      { state: null, replaceState },
    );
    expect(code).toBe(CODE);
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      '/#session=local:en_00000000000000000000000000000001',
    );
  });

  it('removes a malformed code too and leaves URLs without a code untouched', () => {
    const replaceState = vi.fn();
    expect(
      consumeAuthCode(
        { hash: '#code=short', pathname: '/app', search: '?x=1' },
        { state: null, replaceState },
      ),
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app?x=1');
    replaceState.mockClear();
    expect(
      consumeAuthCode({ hash: '#session=x', pathname: '/', search: '' }, { state: null, replaceState }),
    ).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('works against the real location/history (happy-dom)', () => {
    window.history.replaceState(null, '', `/#code=${CODE}`);
    expect(consumeAuthCode(window.location, window.history)).toBe(CODE);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(CODE);
  });
});

describe('createAuthBootstrap', () => {
  it('exchanges the code once (POST /api/auth) and then only asks the status', async () => {
    const { calls, fetchFn } = fakeFetch({
      [API_PATHS.auth]: () => json(200, sampleAuthStatus()),
      [API_PATHS.authStatus]: () => json(200, sampleAuthStatus()),
    });
    const auth = createAuthBootstrap({ code: CODE, fetch: fetchFn });
    await expect(auth.check()).resolves.toEqual({
      kind: 'authenticated',
      serverInstanceId: sampleAuthStatus().serverInstanceId,
    });
    expect(calls.map((call) => call.url)).toEqual([API_PATHS.auth, API_PATHS.authStatus]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ code: CODE }));
    await auth.check();
    expect(calls.map((call) => call.url)).toEqual([
      API_PATHS.auth,
      API_PATHS.authStatus,
      API_PATHS.authStatus,
    ]);
  });

  it('remembers a rejected code and reports "not signed in" (no WS)', async () => {
    const { fetchFn } = fakeFetch({
      [API_PATHS.auth]: () => json(401, { code: 'AUTH_CODE_INVALID', params: {} }),
      [API_PATHS.authStatus]: () => json(200, sampleAuthStatus({ authenticated: false })),
    });
    const auth = createAuthBootstrap({ code: CODE, fetch: fetchFn });
    await expect(auth.check()).resolves.toEqual({ kind: 'unauthenticated', codeRejected: true });
    expect(auth.codeRejected).toBe(true);
  });

  it('still uses an old cookie after a rejected code', async () => {
    const { fetchFn } = fakeFetch({
      [API_PATHS.auth]: () => json(401, { code: 'AUTH_CODE_INVALID', params: {} }),
      [API_PATHS.authStatus]: () => json(200, sampleAuthStatus()),
    });
    const auth = createAuthBootstrap({ code: CODE, fetch: fetchFn });
    await expect(auth.check()).resolves.toMatchObject({ kind: 'authenticated' });
  });

  it('reports "unreachable" on network errors and keeps the code for the next try', async () => {
    let online = false;
    const calls: string[] = [];
    const fetchFn: FetchLike = (url) => {
      calls.push(url);
      if (!online) return Promise.reject(new TypeError('offline'));
      return Promise.resolve(json(200, sampleAuthStatus()));
    };
    const auth = createAuthBootstrap({ code: CODE, fetch: fetchFn });
    await expect(auth.check()).resolves.toEqual({ kind: 'unreachable' });
    online = true;
    await expect(auth.check()).resolves.toMatchObject({ kind: 'authenticated' });
    expect(calls).toEqual([API_PATHS.auth, API_PATHS.auth, API_PATHS.authStatus]);
  });

  it('keeps the code while a proxy answers 5xx (dev: Vite proxy 502 before the server is up)', async () => {
    let up = false;
    const calls: string[] = [];
    const fetchFn: FetchLike = (url) => {
      calls.push(url);
      if (!up) return Promise.resolve(json(502, {}));
      return Promise.resolve(json(200, sampleAuthStatus()));
    };
    const auth = createAuthBootstrap({ code: CODE, fetch: fetchFn });
    await expect(auth.check()).resolves.toEqual({ kind: 'unreachable' });
    expect(auth.codeRejected).toBe(false);
    up = true;
    await expect(auth.check()).resolves.toMatchObject({ kind: 'authenticated' });
    expect(calls).toEqual([API_PATHS.auth, API_PATHS.auth, API_PATHS.authStatus]);
  });

  it('treats an invalid status body as unreachable', async () => {
    const { fetchFn } = fakeFetch({ [API_PATHS.authStatus]: () => json(200, { authenticated: 'yes' }) });
    const auth = createAuthBootstrap({ code: null, fetch: fetchFn });
    await expect(auth.check()).resolves.toEqual({ kind: 'unreachable' });
  });
});
