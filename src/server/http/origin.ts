import type { IncomingHttpHeaders } from 'node:http';
import { makeError, type ErrorPayload } from '@shared/errors';
import { API_PATHS, API_PREFIX, allowedHosts, allowedOrigins } from '@shared/http';

/**
 * Request guard (A.8, normative table: docs/architecture.md §5.1; R1-01, V1-01, ADR-018, ADR-019).
 * Pure: decides from method, raw request target, MATCHED ROUTE and headers; the cookie check
 * itself is done by the caller (`needsCookie`).
 *
 * Classification uses the route Fastify matched (`request.routeOptions.url`), never the URL
 * text: the router (find-my-way) decodes percent-encoding and reduces absolute-form targets before
 * it matches, so a text comparison can be bypassed (`/%61pi/ws`, `GET http://host/api/ws`).
 * Default-deny: a registered route that is not in the table below is a `mutation` (Origin +
 * same-origin + cookie), also for GET – new routes are protected without touching this file.
 *
 * | Class         | Request                                     | Origin               | Sec-Fetch-Site                 | Auth   |
 * | static        | GET/HEAD of the static route `/*`           | –                    | –                              | –      |
 * | public-get    | GET/HEAD /api/health, /api/auth/status      | if present ∈ allowed | if present ∈ same-origin/none  | –      |
 * | not-found     | GET/HEAD without a matching route (404)     | if present ∈ allowed | if present ∈ same-origin/none  | –      |
 * | blob          | GET/HEAD /api/blob/:blobId                  | if present ∈ allowed | if present ∈ same-origin/none  | cookie |
 * | auth-exchange | POST /api/auth                              | required ∈ allowed   | required same-origin           | code   |
 * | ws            | GET/HEAD /api/ws (WebSocket upgrade)        | required ∈ allowed   | if present: same-origin (V1-01)| cookie |
 * | mutation      | every other route/method (default-deny)     | required ∈ allowed   | required same-origin           | cookie |
 * | launcher      | POST /api/launcher/code                     | must be absent       | absent or none                 | bearer |
 *
 * Checked before the table, for every request:
 * - `Host` ∈ `allowedHosts(port, dev)`, else 403 HOST_HEADER_REJECTED.
 * - The request target is in origin form (starts with `/`; no absolute or asterisk form), and on
 *   an API route (pattern under `/api`) the raw path is canonical (`/api/<seg>/<seg>` with
 *   segments of `[A-Za-z0-9_-]`, so no percent-encoding, `.`, `;`, `//` or trailing `/`), else
 *   400 VALIDATION_FAILED {reason: 'request_target'} – defense in depth.
 * - A WebSocket upgrade is accepted only on the WS route, else 400 INVALID_MESSAGE
 *   {reason: 'upgrade_not_allowed'} (@fastify/websocket would otherwise complete the handshake on
 *   any GET route and close it right away).
 * `Origin: null` is rejected wherever Origin is checked. Violations of the table: 403
 * ORIGIN_REJECTED (`params.reason`: `origin`, `origin-null`, `sec-fetch-site`).
 */

export type RouteClass =
  'static' | 'public-get' | 'not-found' | 'blob' | 'auth-exchange' | 'launcher' | 'ws' | 'mutation';

export interface GuardContext {
  /** Port of this server (the actual listening port). */
  port: number;
  dev: boolean;
}

export interface GuardRequest {
  method: string;
  /** Raw request target as received (`request.url`: path + query, origin form expected). */
  url: string;
  /** Pattern of the matched route (`request.routeOptions.url`, e.g. `/api/blob/:blobId`); null = no route (404). */
  route: string | null;
  /** WebSocket upgrade (came through the HTTP `upgrade` event or carries an `Upgrade` header). */
  upgrade: boolean;
  headers: IncomingHttpHeaders;
}

export type GuardResult =
  | { ok: true; route: RouteClass; needsCookie: boolean }
  | { ok: false; route: RouteClass; error: ErrorPayload };

/** Route pattern of @fastify/static with the default prefix `/` (GET/HEAD `/*`). */
export const STATIC_ROUTE = '/*';

const READ_METHODS = ['GET', 'HEAD'] as const;

function forMethods(methods: readonly string[], routeClass: RouteClass): ReadonlyMap<string, RouteClass> {
  return new Map(methods.map((method) => [method, routeClass]));
}

/** Route pattern → method → class. Anything missing here is a `mutation` (default-deny). */
const ROUTE_CLASSES: ReadonlyMap<string, ReadonlyMap<string, RouteClass>> = new Map([
  [STATIC_ROUTE, forMethods(READ_METHODS, 'static')],
  [API_PATHS.health, forMethods(READ_METHODS, 'public-get')],
  [API_PATHS.authStatus, forMethods(READ_METHODS, 'public-get')],
  [API_PATHS.blob, forMethods(READ_METHODS, 'blob')],
  [API_PATHS.ws, forMethods(READ_METHODS, 'ws')],
  [API_PATHS.auth, forMethods(['POST'], 'auth-exchange')],
  [API_PATHS.launcherCode, forMethods(['POST'], 'launcher')],
]);

/** Canonical raw path of an API route (blob ids are hex, all other segments are plain words). */
const CANONICAL_API_PATH = /^\/api(?:\/[A-Za-z0-9_-]+)+$/;

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** Is `route` (a route pattern) an API route? */
export function isApiRoute(route: string | null): boolean {
  return route !== null && (route === API_PREFIX || route.startsWith(`${API_PREFIX}/`));
}

/** Path without query string or fragment (for logs and error params only – never for decisions). */
export function requestPath(url: string): string {
  const end = url.search(/[?#]/);
  return end < 0 ? url : url.slice(0, end);
}

/** Class of a request by method and matched route pattern (null = no route matched). */
export function classifyRequest(method: string, route: string | null): RouteClass {
  if (route === null) return isReadMethod(method) ? 'not-found' : 'mutation';
  return ROUTE_CLASSES.get(route)?.get(method) ?? 'mutation';
}

/** Origin-form target; on API routes additionally the canonical path (no decoding needed). */
function requestTargetOk(url: string, route: string | null): boolean {
  if (!url.startsWith('/')) return false;
  if (!isApiRoute(route)) return true;
  const queryAt = url.indexOf('?');
  return CANONICAL_API_PATH.test(queryAt < 0 ? url : url.slice(0, queryAt));
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
  const route = classifyRequest(request.method, request.route);
  const host = single(request.headers.host);
  if (host === undefined || !allowedHosts(ctx.port, ctx.dev).includes(host)) {
    return { ok: false, route, error: makeError('HOST_HEADER_REJECTED') };
  }
  if (!requestTargetOk(request.url, request.route)) {
    return { ok: false, route, error: makeError('VALIDATION_FAILED', { reason: 'request_target' }) };
  }
  if (request.upgrade && route !== 'ws') {
    return { ok: false, route, error: makeError('INVALID_MESSAGE', { reason: 'upgrade_not_allowed' }) };
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
    case 'not-found':
    case 'blob': {
      const issue = originIssue();
      if (issue !== null) return issue;
      if (site !== undefined && site !== 'same-origin' && site !== 'none')
        return reject(route, 'sec-fetch-site');
      return { ok: true, route, needsCookie: route === 'blob' };
    }
    case 'ws': {
      // V1-01: Chrome/Edge send no Sec-Fetch-Site on the WebSocket handshake. Origin (always sent
      // by browsers on a WebSocket handshake) + Host + cookie carry the check; a present
      // Sec-Fetch-Site must still be same-origin.
      if (origin === undefined) return reject(route, 'origin');
      const issue = originIssue();
      if (issue !== null) return issue;
      if (site !== undefined && site !== 'same-origin') return reject(route, 'sec-fetch-site');
      return { ok: true, route, needsCookie: true };
    }
    case 'auth-exchange':
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
