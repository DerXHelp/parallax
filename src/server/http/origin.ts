import type { IncomingHttpHeaders } from 'node:http';
import { makeError, type ErrorPayload } from '@shared/errors';
import { API_PATHS, API_PREFIX, allowedHosts, allowedOrigins } from '@shared/http';

/**
 * Request guard (A.8, normative table: docs/architecture.md §5.1). Pure: decides from method,
 * path and headers; the cookie check itself is done by the caller (`needsCookie`).
 *
 * | Request                                   | Origin                 | Sec-Fetch-Site            | Auth    |
 * | static page/assets                        | –                      | –                         | –       |
 * | GET /api/health, GET /api/auth/status     | if present ∈ allowed   | if present ∈ same-origin/none | –   |
 * | GET /api/blob/:id                         | if present ∈ allowed   | if present ∈ same-origin/none | cookie |
 * | POST /api/auth                            | required ∈ allowed     | required same-origin      | code    |
 * | WS GET /api/ws, every other non-GET       | required ∈ allowed     | required same-origin      | cookie  |
 * | POST /api/launcher/code                   | must be absent         | absent or none            | bearer  |
 *
 * `Host` must be in `allowedHosts(port, dev)` for every request. `Origin: null` is always
 * rejected where Origin is checked. Violations: 403 ORIGIN_REJECTED (`params.reason`: `origin`,
 * `origin-null`, `sec-fetch-site`) or 403 HOST_HEADER_REJECTED.
 */

export type RouteClass = 'static' | 'public-get' | 'blob' | 'auth-exchange' | 'launcher' | 'ws' | 'mutation';

export interface GuardContext {
  /** Port of this server (the actual listening port). */
  port: number;
  dev: boolean;
}

export interface GuardRequest {
  method: string;
  /** Request URL (path + query). */
  url: string;
  headers: IncomingHttpHeaders;
}

export type GuardResult =
  | { ok: true; route: RouteClass; needsCookie: boolean }
  | { ok: false; route: RouteClass; error: ErrorPayload };

const BLOB_PREFIX = API_PATHS.blob.replace(':blobId', '');

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** Path without query string or fragment. */
export function requestPath(url: string): string {
  const end = url.search(/[?#]/);
  return end < 0 ? url : url.slice(0, end);
}

export function classifyRequest(method: string, url: string): RouteClass {
  const path = requestPath(url);
  const read = isReadMethod(method);
  if (path === API_PATHS.ws && read) return 'ws';
  if (path === API_PATHS.auth && method === 'POST') return 'auth-exchange';
  if (path === API_PATHS.launcherCode && method === 'POST') return 'launcher';
  if (!read) return 'mutation';
  if (path.startsWith(BLOB_PREFIX)) return 'blob';
  if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) return 'public-get';
  return 'static';
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const reject = (route: RouteClass, reason: 'origin' | 'origin-null' | 'sec-fetch-site'): GuardResult => ({
  ok: false,
  route,
  error: makeError('ORIGIN_REJECTED', { reason }),
});

export function checkRequest(request: GuardRequest, ctx: GuardContext): GuardResult {
  const route = classifyRequest(request.method, request.url);
  const host = single(request.headers.host);
  if (host === undefined || !allowedHosts(ctx.port, ctx.dev).includes(host)) {
    return { ok: false, route, error: makeError('HOST_HEADER_REJECTED') };
  }
  if (route === 'static') return { ok: true, route, needsCookie: false };

  const origin = single(request.headers.origin);
  const site = single(request.headers['sec-fetch-site']);
  const origins = allowedOrigins(ctx.port, ctx.dev);
  const originIssue = (): GuardResult | null => {
    if (origin === undefined) return null;
    if (origin === 'null') return reject(route, 'origin-null');
    return origins.includes(origin) ? null : reject(route, 'origin');
  };

  switch (route) {
    case 'public-get':
    case 'blob': {
      const issue = originIssue();
      if (issue !== null) return issue;
      if (site !== undefined && site !== 'same-origin' && site !== 'none')
        return reject(route, 'sec-fetch-site');
      return { ok: true, route, needsCookie: route === 'blob' };
    }
    case 'auth-exchange':
    case 'ws':
    case 'mutation': {
      if (origin === undefined) return reject(route, 'origin');
      const issue = originIssue();
      if (issue !== null) return issue;
      if (site !== 'same-origin') return reject(route, 'sec-fetch-site');
      return { ok: true, route, needsCookie: route !== 'auth-exchange' };
    }
    case 'launcher': {
      // Only the launcher (no browser) may call this: a browser always sends Origin on POST.
      if (origin !== undefined) return reject(route, origin === 'null' ? 'origin-null' : 'origin');
      if (site !== undefined && site !== 'none') return reject(route, 'sec-fetch-site');
      return { ok: true, route, needsCookie: false };
    }
  }
}
