/**
 * HTTP/auth contract between web UI (WP-14), server (WP-10) and launcher (WP-21): paths,
 * request/response schemas, auth cookie, launcher lock file and pure helpers for the `#code=`
 * hand-over (A.8, B "Lockfile per Health-Ping", C.8, C.10; R0-01, ADR-015).
 * Normative flows and the request guard table: docs/architecture.md §5.1.
 * Every HTTP error body is an `ErrorPayload`; the status is `ERROR_CATALOG[code].http`.
 * Import order: after protocol (common → errors → status → model → protocol → sync | http | paths).
 */
import { z } from 'zod';
import { LIMITS, isoDateTimeSchema, type BlobId } from './common';
import { errorPayloadSchema } from './errors';
import { PRODUCT_ID } from './product';
import { WS_PATH } from './protocol';

// =====================================================================================
// Paths (all server routes live under /api, ADR-006)
// =====================================================================================

export const API_PREFIX = '/api';

export const API_PATHS = {
  /** GET, no auth: single-instance check of the launcher (C.8) via `serverInstanceId`. */
  health: '/api/health',
  /** POST `{code}` → persistent device cookie (A.8). */
  auth: '/api/auth',
  /** GET, also without cookie: is this browser signed in? Asked before the WS (R0-01). */
  authStatus: '/api/auth/status',
  /** POST with `Authorization: Bearer <launcherToken>` and without Origin: fresh one-time code. */
  launcherCode: '/api/launcher/code',
  /** GET with cookie; route pattern – build URLs with blobPath(). */
  blob: '/api/blob/:blobId',
  /** POST upload → BlobRef (WP-02 §5.5); Phase 1 answers NOT_IMPLEMENTED. */
  attachments: '/api/attachments',
  /** WebSocket upgrade (src/shared/protocol.ts). */
  ws: WS_PATH,
} as const;

/** `/api/blob/<blobId>` (full content of capped texts, images). */
export function blobPath(blobId: BlobId): string {
  return API_PATHS.blob.replace(':blobId', blobId);
}

// =====================================================================================
// Host and Origin (A.8: checked for every request; Origin/Sec-Fetch-Site see §5.1 table)
// =====================================================================================

/** The server binds only here; `localhost` is not accepted as Host. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Vite dev server (ADR-006, mirrors DEV_WEB_PORT in repo.config.ts). */
export const DEV_WEB_PORT = 5173;

export const portSchema = z.number().int().min(1).max(65535);

function checkedPort(port: number): number {
  if (!portSchema.safeParse(port).success) throw new RangeError(`invalid port ${String(port)}`);
  return port;
}

/** `http://127.0.0.1:<port>` – the page origin of a server on `port`. */
export function serverOrigin(port: number): string {
  return `http://${LOOPBACK_HOST}:${String(checkedPort(port))}`;
}

/** Accepted `Host` headers: `127.0.0.1:<port>`; with `--dev` also the Vite host (proxy keeps Host). */
export function allowedHosts(port: number, dev: boolean): string[] {
  const own = `${LOOPBACK_HOST}:${String(checkedPort(port))}`;
  return dev ? [own, `${LOOPBACK_HOST}:${String(DEV_WEB_PORT)}`] : [own];
}

/** Accepted `Origin` headers (never `null`); with `--dev` also the Vite origin. */
export function allowedOrigins(port: number, dev: boolean): string[] {
  return dev ? [serverOrigin(port), serverOrigin(DEV_WEB_PORT)] : [serverOrigin(port)];
}

// =====================================================================================
// One-time codes, launcher token, device cookie
// =====================================================================================

/** Random bytes of codes and tokens; encoded as base64url without padding (43 chars). */
export const AUTH_TOKEN_BYTES = 32;
const base64Url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** One-time code in `#code=` (single use, short-lived). */
export const authCodeSchema = base64Url32;
export type AuthCode = z.infer<typeof authCodeSchema>;

/** Random secret per server start, only in the lock file; authorizes `POST /api/launcher/code`. */
export const launcherTokenSchema = base64Url32;
export type LauncherToken = z.infer<typeof launcherTokenSchema>;

/** Lifetime of a one-time code (coordinator decision: ≤ 60 s). */
export const AUTH_CODE_TTL_MS = 60_000;
/** Only for the dev URL logged by `--dev` at start (developer opens it by hand). */
export const DEV_AUTH_CODE_TTL_MS = 10 * 60_000;

/** Persistent device cookie (A.8); browsers cap Max-Age at 400 days. */
export const AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * Attributes of the device cookie. No `Secure` (plain http on loopback), no `Domain`.
 * The value is opaque to clients (signed by the persistent, rotatable secret in PARALLAX_HOME).
 */
export const AUTH_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  sameSite: 'strict',
  path: '/',
  maxAgeSeconds: AUTH_COOKIE_MAX_AGE_SECONDS,
} as const;

/**
 * Cookie name with the port of the issuing server (`parallax_4711`): SameSite ignores the port,
 * so several servers on 127.0.0.1 must not share a cookie. Dev: the server's own port (4712),
 * not the Vite port.
 */
export function authCookieName(port: number): string {
  return `${PRODUCT_ID}_${String(checkedPort(port))}`;
}

// =====================================================================================
// Requests and responses
// =====================================================================================

/** `POST /api/auth` body. */
export const authExchangeRequestSchema = z.object({ code: authCodeSchema });
export type AuthExchangeRequest = z.infer<typeof authExchangeRequestSchema>;

/** `GET /api/auth/status` – always 200 (never 401), so the client can tell "signed out" from "down". */
export const authStatusResponseSchema = z.object({
  authenticated: z.boolean(),
  /** Lets the client detect a restarted server before the WS `hello`. */
  serverInstanceId: z.uuid(),
});
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;

/** `POST /api/auth` success (200 + Set-Cookie); failure 401 AUTH_CODE_INVALID. */
export const authExchangeResponseSchema = authStatusResponseSchema.extend({ authenticated: z.literal(true) });
export type AuthExchangeResponse = z.infer<typeof authExchangeResponseSchema>;

/** `POST /api/launcher/code` body: empty or `{}`. */
export const launcherCodeRequestSchema = z.object({});

/** `POST /api/launcher/code` success; also what the server issues in-process at the first start. */
export const launcherCodeResponseSchema = z.object({
  code: authCodeSchema,
  expiresAt: isoDateTimeSchema,
  serverInstanceId: z.uuid(),
});
export type LauncherCodeResponse = z.infer<typeof launcherCodeResponseSchema>;

/** `GET /api/health` – no secrets; the launcher compares `serverInstanceId` with the lock file. */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  product: z.literal(PRODUCT_ID),
  serverInstanceId: z.uuid(),
  serverVersion: z.string().min(1),
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  startedAt: isoDateTimeSchema,
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Body of every HTTP error response (also of a rejected WS upgrade). */
export const httpErrorBodySchema = errorPayloadSchema;

// =====================================================================================
// Launcher authorization header
// =====================================================================================

/** `Authorization` header value for `POST /api/launcher/code`. */
export function bearerAuthorization(token: LauncherToken): string {
  return `Bearer ${token}`;
}

/** Token from an `Authorization` header, or null if absent/malformed (scheme case-insensitive). */
export function parseBearerToken(header: string | undefined): LauncherToken | null {
  const match = /^bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const parsed = launcherTokenSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}

// =====================================================================================
// `#code=` hand-over (launcher → page, A.8)
// =====================================================================================

export const AUTH_HASH_PARAM = 'code';

/** URL the launcher opens: `<origin>/#code=<code>` (the code never goes into a query string). */
export function appUrlWithCode(origin: string, code: AuthCode): string {
  return `${origin}/#${AUTH_HASH_PARAM}=${code}`;
}

/**
 * Client side: splits `location.hash` into the auth code (null if absent or malformed) and the
 * remaining hash (e.g. `#session=…`, '' if nothing remains). Every `code=` part is removed, also
 * a malformed one – the client always calls `history.replaceState` with the remaining hash.
 */
export function takeAuthCodeFromHash(hash: string): { code: AuthCode | null; hash: string } {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  let code: AuthCode | null = null;
  const rest: string[] = [];
  for (const part of body.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (key !== AUTH_HASH_PARAM) {
      rest.push(part);
      continue;
    }
    const parsed = authCodeSchema.safeParse(eq < 0 ? '' : part.slice(eq + 1));
    if (parsed.success && code === null) code = parsed.data;
  }
  return { code, hash: rest.length === 0 ? '' : `#${rest.join('&')}` };
}

// =====================================================================================
// Lock file (single instance, C.8; written at server start, read by the launcher – WP-21)
// =====================================================================================

/** `PARALLAX_HOME/server.lock.json`. */
export const SERVER_LOCK_FILE = 'server.lock.json';
export const SERVER_LOCK_SCHEMA_VERSION = 1;

export const serverLockFileSchema = z.object({
  schemaVersion: z.literal(SERVER_LOCK_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  port: portSchema,
  /** Must equal `GET /api/health`.serverInstanceId, otherwise the lock file is stale. */
  serverInstanceId: z.uuid(),
  launcherToken: launcherTokenSchema,
  startedAt: isoDateTimeSchema,
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
});
export type ServerLockFile = z.infer<typeof serverLockFileSchema>;
