/**
 * HTTP/auth contract between web UI (WP-14), server (WP-10) and launcher (WP-21): paths,
 * request/response schemas, auth cookie, launcher lock file and pure helpers for the `#code=`
 * hand-over (A.8, B "Lockfile per Health-Ping", C.8, C.10; R0-01, ADR-015).
 * Normative flows and the request guard table: docs/architecture.md §5.1.
 * Every HTTP error body is an `ErrorPayload`; the status is `ERROR_CATALOG[code].http`.
 * Import order: after protocol (common → errors → status → model → protocol → sync | http | paths).
 */
import { z } from 'zod';
import {
  LIMITS,
  LOCAL_HOST_ID,
  entryIdSchema,
  hostIdSchema,
  isoDateTimeSchema,
  makeSessionKey,
  type BlobId,
  type EntryId,
  type HostId,
} from './common';
import { DEV_WEB_PORT } from './devPorts';
import { errorPayloadSchema } from './errors';
import {
  appVersionSchema,
  blobRefSchema,
  hostNameSchema,
  remoteAccessStateSchema,
  remotePeerLevelSchema,
} from './model';
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
  /**
   * WP-102 (WP-76 §B.13): POST `launcherRemoteRequestSchema` → `launcherRemoteResponseSchema` with
   * `Authorization: Bearer <launcherToken>` and without Origin, Sec-Fetch-* or Cookie (like
   * `launcherCode`): "Share" and the coupling from the command line (`parallax remote …`), e.g. on a
   * computer without a desktop. The pairing code only in the answer to `pair`, never logged.
   */
  launcherRemote: '/api/launcher/remote',
  /** GET with cookie; route pattern – build URLs with blobPath(). */
  blob: '/api/blob/:blobId',
  /**
   * POST image upload → `attachmentUploadResponseSchema` (Phase 2, ADR-103; guard class
   * "mutation": Origin, same-origin, cookie). Query `attachmentUploadQuerySchema`.
   */
  attachments: '/api/attachments',
  /**
   * GET/HEAD file content (Phase 3, ADR-142), query `fileQuerySchema` – build URLs with fileUrl().
   * Guard class "file": Sec-Fetch-Site REQUIRED `same-origin`, Origin if present ∈ allowedOrigins,
   * cookie (file paths can be guessed, unlike blob hashes).
   */
  file: '/api/file',
  /**
   * WP-87: POST an update zip ("Install from file", `UPDATE_PACKAGE_MEDIA_TYPES`, at most
   * `UPDATE_PACKAGE_MAX_BYTES`, streamed to disk) → 202 `updatePackageResponseSchema`; checking and
   * staging run in the background (HostState.update). Guard class "mutation".
   */
  updatePackage: '/api/update/package',
  /** WP-87: GET `changelogQuerySchema` → `changelogResponseSchema`. Guard class "file". */
  changelog: '/api/changelog',
  /** WP-87: GET `noticesQuerySchema` → `noticesResponseSchema` (running version). Guard class "file". */
  notices: '/api/notices',
  /**
   * WebSocket upgrade (src/shared/protocol.ts). Guard (§5.1, ADR-019): Origin ∈ allowedOrigins,
   * Host and device cookie required; Sec-Fetch-Site only checked when present (browsers send none
   * on the handshake) and then must be `same-origin`. Only this route and `terminalWs` (WP-99) accept an upgrade.
   */
  ws: WS_PATH,
  /**
   * WP-99 (ADR-239): WebSocket of the embedded terminal (`src/shared/terminal.ts`). Guard class "ws"
   * like `ws`. WP-102 (E3, WP-76 §B.13): a controlling computer reaches it through
   * `HOST_API_PATHS.terminalWs` → `REMOTE_PATHS.terminalWs`.
   */
  terminalWs: '/api/terminal/ws',
} as const;

/** `/api/blob/<blobId>` (full content of capped texts, images). */
export function blobPath(blobId: BlobId): string {
  return API_PATHS.blob.replace(':blobId', blobId);
}

/** Query of `GET /api/file` (Phase 3, ADR-142); the server runs the checks of file.stat (ADR-141). */
export const fileQuerySchema = z.object({
  entryId: entryIdSchema,
  path: z.string().min(1).max(LIMITS.pathChars),
});
export type FileQuery = z.infer<typeof fileQuerySchema>;

/** `/api/file?entryId=…&path=…` (both encoded with encodeURIComponent). */
export function fileUrl(entryId: EntryId, path: string): string {
  return `${API_PATHS.file}?entryId=${encodeURIComponent(entryId)}&path=${encodeURIComponent(path)}`;
}

// ---- WP-87: updates (docs/wp/WP-87.md §1.4) ----

export const UPDATE_PACKAGE_MEDIA_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
] as const;
export const UPDATE_PACKAGE_MAX_BYTES = 200 * 1024 * 1024;
export const updatePackageResponseSchema = z.object({ accepted: z.literal(true) });
export type UpdatePackageResponse = z.infer<typeof updatePackageResponseSchema>;

export const changelogQuerySchema = z.object({
  /** `installed` = the running version's CHANGELOG.md; `available` = that of HostState.update.available. */
  for: z.enum(['installed', 'available']),
  /** `installed` only: the sections after this version; without it the running version's own section. */
  since: appVersionSchema.optional(),
});
export type ChangelogQuery = z.infer<typeof changelogQuerySchema>;
export const changelogSectionSchema = z.object({
  /** null = [Unveröffentlicht] (a pre-release has no section of its own). */
  version: appVersionSchema.nullable(),
  date: z.iso.date().nullable(),
  /** Markdown, rendered without raw HTML. */
  body: z.string().max(200_000),
});
export type ChangelogSection = z.infer<typeof changelogSectionSchema>;
export const changelogResponseSchema = z.object({
  /** The version whose CHANGELOG.md was read. */
  version: z.string().min(1).max(64),
  sections: z.array(changelogSectionSchema).max(100),
});
export type ChangelogResponse = z.infer<typeof changelogResponseSchema>;

export const NOTICE_FILES = ['license', 'third-party'] as const;
export type NoticeFile = (typeof NOTICE_FILES)[number];
export const noticesQuerySchema = z.object({ file: z.enum(NOTICE_FILES) });
export const noticesResponseSchema = z.object({
  file: z.enum(NOTICE_FILES),
  text: z.string().max(16_000_000),
});
export type NoticesResponse = z.infer<typeof noticesResponseSchema>;

// =====================================================================================
// Host and Origin (A.8: checked for every request; Origin/Sec-Fetch-Site see §5.1 table)
// =====================================================================================

/** The server binds only here; `localhost` is not accepted as Host. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Vite dev server (ADR-006); defined import-free in devPorts.ts (root configs load it). */
export { DEV_WEB_PORT };

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

/**
 * `POST /api/launcher/remote` body (WP-102, WP-76 §B.13): `status`; `enable`/`disable` = "Share"
 * on/off (role `share` resp. `off`); `pair` = open a pairing window with that level (replaces an
 * open one); `cancel` = close it; `unpair` = revoke the coupling; `level` = change its level.
 */
export const launcherRemoteRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({ action: z.literal('enable') }),
  z.object({ action: z.literal('disable') }),
  z.object({ action: z.literal('pair'), level: remotePeerLevelSchema.default('control') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('unpair') }),
  z.object({ action: z.literal('level'), level: remotePeerLevelSchema }),
]);
export type LauncherRemoteRequest = z.infer<typeof launcherRemoteRequestSchema>;

/**
 * `POST /api/launcher/remote` success: the state after the action (`null` = not sharing) and, only
 * for `pair`, the formatted code (`src/shared/pairing.ts`) and the end of the window. Errors as
 * `ErrorPayload` with the code's HTTP status (e.g. LAUNCHER_TOKEN_INVALID, REMOTE_KEYSTORE_UNAVAILABLE).
 */
export const launcherRemoteResponseSchema = z.object({
  remoteAccess: remoteAccessStateSchema.nullable(),
  code: z.string().min(1).max(64).nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
});
export type LauncherRemoteResponse = z.infer<typeof launcherRemoteResponseSchema>;

/** Session backend of a server: `sdk` = the real `claude`, `fake` = FakeBackend (no tokens). */
export const backendKindSchema = z.enum(['sdk', 'fake']);
export type BackendKind = z.infer<typeof backendKindSchema>;

/** `GET /api/health` – no secrets; the launcher compares `serverInstanceId` with the lock file. */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  product: z.literal(PRODUCT_ID),
  serverInstanceId: z.uuid(),
  serverVersion: z.string().min(1),
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  startedAt: isoDateTimeSchema,
  /**
   * Backend of the running server (R3-02, additive): the launcher refuses to open a window of a
   * server whose backend differs from the requested one. Absent on builds before R3.
   */
  backend: backendKindSchema.optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Body of every HTTP error response (also of a rejected WS upgrade). */
export const httpErrorBodySchema = errorPayloadSchema;

// =====================================================================================
// Upload (images: Phase 2, ADR-103; PDFs and other files: Phase 3, ADR-146)
// =====================================================================================

/** Image types of an upload = the SDK's Base64ImageSource media types. */
export const ATTACHMENT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const attachmentMediaTypeSchema = z.enum(ATTACHMENT_MEDIA_TYPES);
export type AttachmentMediaType = z.infer<typeof attachmentMediaTypeSchema>;

/**
 * Query of `POST /api/attachments?name=…&width=…&height=…`. The body is the raw image
 * (`Content-Type` ∈ ATTACHMENT_MEDIA_TYPES, ≤ LIMITS.imageBytes, magic bytes checked by the
 * server): 413 PAYLOAD_TOO_LARGE, 415 UNSUPPORTED_MEDIA_TYPE, 400 VALIDATION_FAILED.
 */
export const attachmentUploadQuerySchema = z.object({
  name: z.string().min(1).max(260).optional(),
  width: z.coerce.number().int().positive().max(100_000).optional(),
  height: z.coerce.number().int().positive().max(100_000).optional(),
});
export type AttachmentUploadQuery = z.infer<typeof attachmentUploadQuerySchema>;

/** `POST /api/attachments` success (200). */
export const attachmentUploadResponseSchema = z.object({ attachment: blobRefSchema });
export type AttachmentUploadResponse = z.infer<typeof attachmentUploadResponseSchema>;

/**
 * Header `Content-Type` of `POST /api/attachments` (Phase 3, ADR-146): images, PDF, any other file
 * as octet-stream. The server decides by magic bytes; octet-stream requires the query `name`.
 */
export const UPLOAD_MEDIA_TYPES = [
  ...ATTACHMENT_MEDIA_TYPES,
  'application/pdf',
  'application/octet-stream',
] as const;
export const uploadMediaTypeSchema = z.enum(UPLOAD_MEDIA_TYPES);
export type UploadMediaType = z.infer<typeof uploadMediaTypeSchema>;

// =====================================================================================
// Content-Security-Policy (C.10, ADR-026; R1W-23/R3-14: one source for every server of the UI)
// =====================================================================================

/** Directive name → sources, in header order. */
export type CspDirectives = readonly (readonly [directive: string, sources: readonly string[]])[];

/**
 * Page CSP of the UI served by a server on `port`: scripts only from the own origin (no inline,
 * no eval), inline styles allowed (Radix injects `<style>`, ADR-026), images also `data:`/`blob:`,
 * network only to the own origin and its WebSocket; no plugins, no `<base>`, no framing, no forms.
 */
export function pageCspDirectives(port: number): CspDirectives {
  return [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'none'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    ['connect-src', ["'self'", `ws://${LOOPBACK_HOST}:${String(checkedPort(port))}`]],
  ];
}

/** Blob answers (`/api/blob/:id`): never rendered as a document of the app's origin. */
export const BLOB_CSP_DIRECTIVES: CspDirectives = [
  ['sandbox', []],
  ['default-src', ["'none'"]],
];

/** Header value: `directive source source; directive …`. */
export function cspHeaderValue(directives: CspDirectives): string {
  return directives.map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
}

/** `Content-Security-Policy` of the pages of a server on `port`. */
export function pageCsp(port: number): string {
  return cspHeaderValue(pageCspDirectives(port));
}

/** `Content-Security-Policy` of blob answers. */
export const BLOB_CSP = cspHeaderValue(BLOB_CSP_DIRECTIVES);

/**
 * PDF answers (Phase 3, ADR-142: GET /api/file and /api/blob with a verified `%PDF-` body): the
 * Chrome PDF viewer does not run in sandboxed documents, so no `sandbox` – but nothing else may
 * load, and only same-origin framing (side panel iframe; then X-Frame-Options SAMEORIGIN). Every
 * other answer keeps BLOB_CSP.
 */
export const FILE_PDF_CSP_DIRECTIVES: CspDirectives = [
  ['default-src', ["'none'"]],
  ['object-src', ["'self'"]],
  ['frame-ancestors', ["'self'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
];

/** `Content-Security-Policy` of PDF answers. */
export const FILE_PDF_CSP = cspHeaderValue(FILE_PDF_CSP_DIRECTIVES);

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

/** `#session=<entryId>` selects a session (web `state/selection.ts`; launcher `--open`). */
export const SESSION_HASH_PARAM = 'session';

/**
 * URL the launcher opens: `<origin>/#code=<code>` (the code never goes into a query string), with
 * `options.entryId` also `&session=<entryId>` (Phase 2: protocol handler, ADR-109); with a
 * `hostId` of another computer (WP-81, toast of a controlling computer) `&session=<hostId>:<entryId>`.
 */
export function appUrlWithCode(
  origin: string,
  code: AuthCode,
  options: { entryId?: EntryId; hostId?: HostId } = {},
): string {
  const { entryId, hostId } = options;
  let session = '';
  if (entryId !== undefined) {
    const value =
      hostId === undefined || hostId === LOCAL_HOST_ID ? entryId : makeSessionKey(hostId, entryId);
    session = `&${SESSION_HASH_PARAM}=${value}`;
  }
  return `${origin}/#${AUTH_HASH_PARAM}=${code}${session}`;
}

// =====================================================================================
// Protocol handler `parallax:` (Phase 2, A.9, ADR-109; opt-in)
// =====================================================================================

export const PROTOCOL_SCHEME = PRODUCT_ID;

/** `parallax://session/<entryId>` – the launch URI of a native toast. */
export function sessionProtocolUri(entryId: EntryId): string {
  return `${PROTOCOL_SCHEME}://session/${entryId}`;
}

const SESSION_URI = new RegExp(`^${PROTOCOL_SCHEME}:(?://)?session/([^/]+)/?$`, 'i');

/**
 * Strict parser of the argument the protocol handler receives (any web page can trigger
 * `parallax:` – R5): scheme case-insensitive, `//` optional, one optional trailing `/`, the id must
 * be a valid entry id; anything else → null.
 */
export function parseSessionProtocolUri(uri: string): EntryId | null {
  const match = SESSION_URI.exec(uri.trim());
  const parsed = entryIdSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}

/**
 * WP-76 (ADR-207): `parallax://session/<hostId>/<entryId>` for a session of another computer (the
 * toast of a controlling computer); for this computer the old form `sessionProtocolUri(entryId)`.
 */
export function hostSessionProtocolUri(hostId: HostId, entryId: EntryId): string {
  return hostId === LOCAL_HOST_ID
    ? sessionProtocolUri(entryId)
    : `${PROTOCOL_SCHEME}://session/${hostId}/${entryId}`;
}

const HOST_SESSION_URI = new RegExp(`^${PROTOCOL_SCHEME}:(?://)?session/([^/]+)/([^/]+)/?$`, 'i');

/**
 * Strict parser for both forms: `session/<entryId>` → this computer, `session/<hostId>/<entryId>` →
 * that computer (`local` is not accepted as an explicit host); anything else → null.
 */
export function parseHostSessionProtocolUri(uri: string): { hostId: HostId; entryId: EntryId } | null {
  const local = parseSessionProtocolUri(uri);
  if (local !== null) return { hostId: LOCAL_HOST_ID, entryId: local };
  const match = HOST_SESSION_URI.exec(uri.trim());
  const hostId = hostIdSchema.safeParse(match?.[1]);
  const entryId = entryIdSchema.safeParse(match?.[2]);
  if (!hostId.success || !entryId.success || hostId.data === LOCAL_HOST_ID) return null;
  return { hostId: hostId.data, entryId: entryId.data };
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

// =====================================================================================
// Several computers (WP-76, docs/wp/WP-76.md §C.3)
// =====================================================================================

/**
 * Forwarding routes of a controlling computer, under its own origin and with the same guards as the
 * local routes (`ws` → class ws, `blob` → blob, `file` → file, `attachments` → mutation). `:hostId`
 * is a `HostState.remoteHosts[].hostId`; the server proxies to the REMOTE_PATHS of that computer and
 * sets the response headers itself (never the other computer's).
 */
export const HOST_API_PATHS = {
  ws: '/api/hosts/:hostId/ws',
  blob: '/api/hosts/:hostId/blob/:blobId',
  file: '/api/hosts/:hostId/file',
  attachments: '/api/hosts/:hostId/attachments',
  /** WP-102 (E3): the embedded terminal of that computer (class ws) → `REMOTE_PATHS.terminalWs`. */
  terminalWs: '/api/hosts/:hostId/terminal/ws',
} as const;

/** `/api/hosts/<hostId>/ws`. */
export function hostWsPath(hostId: HostId): string {
  return HOST_API_PATHS.ws.replace(':hostId', hostId);
}

/** `/api/terminal/ws` for this computer, `/api/hosts/<hostId>/terminal/ws` for another (WP-102). */
export function hostTerminalWsPath(hostId: HostId): string {
  if (hostId === LOCAL_HOST_ID) return API_PATHS.terminalWs;
  return HOST_API_PATHS.terminalWs.replace(':hostId', hostId);
}

/** `/api/blob/<blobId>` for this computer, `/api/hosts/<hostId>/blob/<blobId>` for another. */
export function hostBlobPath(hostId: HostId, blobId: BlobId): string {
  if (hostId === LOCAL_HOST_ID) return blobPath(blobId);
  return HOST_API_PATHS.blob.replace(':hostId', hostId).replace(':blobId', blobId);
}

/** `fileUrl()` for this computer, the forwarding path for another. */
export function hostFileUrl(hostId: HostId, entryId: EntryId, path: string): string {
  if (hostId === LOCAL_HOST_ID) return fileUrl(entryId, path);
  const base = HOST_API_PATHS.file.replace(':hostId', hostId);
  return `${base}?entryId=${encodeURIComponent(entryId)}&path=${encodeURIComponent(path)}`;
}

/** `/api/attachments` for this computer, the forwarding path for another. */
export function hostAttachmentsPath(hostId: HostId): string {
  return hostId === LOCAL_HOST_ID
    ? API_PATHS.attachments
    : HOST_API_PATHS.attachments.replace(':hostId', hostId);
}

/**
 * Routes of the remote-access listener of a sharing computer (HTTPS, TLS profile and pins of
 * docs/wp/WP-76.md §B; nothing else is served). `pair` only on a socket of an open pairing window;
 * all others only on a socket whose client key is the pinned one.
 */
export const REMOTE_PREFIX = '/remote/v1';
export const REMOTE_PATHS = {
  /** POST `remotePairRequestSchema` → `remotePairResponseSchema` (§B.7). */
  pair: '/remote/v1/pair',
  /** GET → `remoteHealthResponseSchema`. */
  health: '/remote/v1/health',
  /** WebSocket upgrade → the sync hub like a window (or the relay, `clientHello.kind`). */
  ws: '/remote/v1/ws',
  /** WP-102 (E3): WebSocket upgrade → the embedded terminal like `/api/terminal/ws` (every level). */
  terminalWs: '/remote/v1/terminal/ws',
  /** GET like `/api/blob/:blobId`. */
  blob: '/remote/v1/blob/:blobId',
  /** GET/HEAD like `/api/file` (query `fileQuerySchema`). */
  file: '/remote/v1/file',
  /** POST like `/api/attachments` (query `attachmentUploadQuerySchema`). */
  attachments: '/remote/v1/attachments',
  /** DELETE: the controlling computer drops its own coupling (`hosts.remove`). */
  peerSelf: '/remote/v1/peer/self',
} as const;

/**
 * Sent by the controlling computer with every request to a sharing computer (lower-case, as Node
 * delivers them); a different version or protocol → 409 HOST_INCOMPATIBLE (§B.9).
 */
export const REMOTE_HEADERS = {
  version: 'parallax-version',
  protocol: 'parallax-protocol',
} as const;

/** Largest body of `POST /remote/v1/pair` (§B.10). */
export const REMOTE_PAIR_BODY_MAX_BYTES = 4096;

/** 48 bytes (HMAC-SHA-384), base64url without padding. */
const base64Url48 = z.string().regex(/^[A-Za-z0-9_-]{64}$/);

export const remotePairRequestSchema = z.object({
  /** Name the controlling computer gives itself (shown as unverified until the pairing succeeded). */
  deviceName: hostNameSchema,
  /** HMAC-SHA-384(k, lp('initiator') ‖ T), §B.7 step 5. */
  macA: base64Url48,
});
export type RemotePairRequest = z.infer<typeof remotePairRequestSchema>;

export const remotePairResponseSchema = z.object({
  /** HMAC-SHA-384(k, lp('responder') ‖ T), §B.7 step 7. */
  macB: base64Url48,
  hostName: z.string().min(1).max(LIMITS.hostAddressChars),
  appVersion: appVersionSchema,
  protocolVersion: z.number().int().positive(),
});
export type RemotePairResponse = z.infer<typeof remotePairResponseSchema>;

export const remoteHealthResponseSchema = z.object({
  appVersion: appVersionSchema,
  protocolVersion: z.number().int().positive(),
  buildId: z.string().min(1).max(LIMITS.buildIdChars),
  hostName: z.string().min(1).max(LIMITS.hostAddressChars),
  serverInstanceId: z.uuid(),
});
export type RemoteHealthResponse = z.infer<typeof remoteHealthResponseSchema>;
