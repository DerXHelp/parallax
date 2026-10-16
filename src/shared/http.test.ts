import { describe, expect, it } from 'vitest';
import { errorSpec } from './errors';
import {
  API_PATHS,
  API_PREFIX,
  ATTACHMENT_MEDIA_TYPES,
  AUTH_CODE_TTL_MS,
  AUTH_COOKIE_ATTRIBUTES,
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_TOKEN_BYTES,
  BLOB_CSP,
  BLOB_CSP_DIRECTIVES,
  DEV_AUTH_CODE_TTL_MS,
  DEV_WEB_PORT,
  LOOPBACK_HOST,
  PROTOCOL_SCHEME,
  SERVER_LOCK_FILE,
  SESSION_HASH_PARAM,
  allowedHosts,
  allowedOrigins,
  appUrlWithCode,
  attachmentMediaTypeSchema,
  attachmentUploadQuerySchema,
  attachmentUploadResponseSchema,
  authCodeSchema,
  authCookieName,
  authExchangeRequestSchema,
  authExchangeResponseSchema,
  authStatusResponseSchema,
  backendKindSchema,
  bearerAuthorization,
  blobPath,
  cspHeaderValue,
  healthResponseSchema,
  httpErrorBodySchema,
  launcherCodeRequestSchema,
  launcherCodeResponseSchema,
  launcherTokenSchema,
  pageCsp,
  pageCspDirectives,
  parseBearerToken,
  parseSessionProtocolUri,
  serverLockFileSchema,
  serverOrigin,
  sessionProtocolUri,
  takeAuthCodeFromHash,
} from './http';
import { WS_PATH } from './protocol';
import {
  SAMPLE_IDS,
  sampleAuthStatus,
  sampleBlobId,
  sampleHealthResponse,
  sampleLauncherCode,
  sampleServerLockFile,
  sampleToken,
} from './samples';

const code = sampleToken(1);
const token = sampleToken(2);

describe('paths', () => {
  it('every route lives under /api (Vite proxy, ADR-006) and the WS path is the protocol one', () => {
    for (const path of Object.values(API_PATHS)) expect(path.startsWith(`${API_PREFIX}/`), path).toBe(true);
    expect(API_PATHS.ws).toBe(WS_PATH);
    expect(new Set(Object.values(API_PATHS)).size).toBe(Object.values(API_PATHS).length);
  });

  it('blobPath fills the route pattern', () => {
    expect(blobPath(sampleBlobId(1))).toBe(`/api/blob/${sampleBlobId(1)}`);
  });
});

describe('hosts and origins (A.8)', () => {
  it('production accepts exactly 127.0.0.1:<port>', () => {
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
    expect(serverOrigin(4711)).toBe('http://127.0.0.1:4711');
    expect(allowedHosts(4711, false)).toEqual(['127.0.0.1:4711']);
    expect(allowedOrigins(4711, false)).toEqual(['http://127.0.0.1:4711']);
  });

  it('--dev additionally accepts Origin AND Host of the Vite dev server', () => {
    expect(allowedHosts(4712, true)).toEqual(['127.0.0.1:4712', `127.0.0.1:${String(DEV_WEB_PORT)}`]);
    expect(allowedOrigins(4712, true)).toEqual(['http://127.0.0.1:4712', 'http://127.0.0.1:5173']);
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])('rejects port %s', (port) => {
    expect(() => serverOrigin(port)).toThrow(RangeError);
    expect(() => authCookieName(port)).toThrow(RangeError);
  });
});

describe('content security policy (C.10, ADR-026, R3-14)', () => {
  it('page CSP: scripts only from self, no plugins/base/framing/forms, own WebSocket only', () => {
    const csp = pageCsp(4711);
    expect(csp).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws://127.0.0.1:4711",
      ].join('; '),
    );
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(cspHeaderValue(pageCspDirectives(4800))).toContain('ws://127.0.0.1:4800');
    expect(() => pageCspDirectives(0)).toThrow(RangeError);
  });

  it('blob CSP sandboxes every answer', () => {
    expect(BLOB_CSP).toBe("sandbox; default-src 'none'");
    expect(cspHeaderValue(BLOB_CSP_DIRECTIVES)).toBe(BLOB_CSP);
  });
});

describe('codes, tokens, cookie', () => {
  it('codes and launcher tokens are 32 bytes as base64url (43 chars)', () => {
    expect(AUTH_TOKEN_BYTES).toBe(32);
    expect(Math.ceil((AUTH_TOKEN_BYTES * 4) / 3)).toBe(43);
    expect(authCodeSchema.safeParse(code).success).toBe(true);
    expect(launcherTokenSchema.safeParse(token).success).toBe(true);
    expect(authCodeSchema.safeParse(code.slice(1)).success).toBe(false);
    expect(authCodeSchema.safeParse(`${code.slice(1)}=`).success).toBe(false);
    expect(authCodeSchema.safeParse(`${code.slice(1)}+`).success).toBe(false);
  });

  it('one-time codes live at most 60 s (dev URL longer)', () => {
    expect(AUTH_CODE_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(DEV_AUTH_CODE_TTL_MS).toBeGreaterThan(AUTH_CODE_TTL_MS);
  });

  it('the cookie name carries the port, attributes are HttpOnly + SameSite=Strict', () => {
    expect(authCookieName(4711)).toBe('parallax_4711');
    expect(authCookieName(4712)).not.toBe(authCookieName(4711));
    expect(AUTH_COOKIE_ATTRIBUTES).toEqual({
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAgeSeconds: AUTH_COOKIE_MAX_AGE_SECONDS,
    });
    expect(AUTH_COOKIE_MAX_AGE_SECONDS).toBeLessThanOrEqual(400 * 24 * 3600);
  });

  it('bearer header round trip; malformed headers give null', () => {
    expect(bearerAuthorization(token)).toBe(`Bearer ${token}`);
    expect(parseBearerToken(bearerAuthorization(token))).toBe(token);
    expect(parseBearerToken(`bearer ${token}`)).toBe(token);
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken(token)).toBeNull();
    expect(parseBearerToken(`Basic ${token}`)).toBeNull();
    expect(parseBearerToken('Bearer short')).toBeNull();
  });
});

describe('request / response schemas', () => {
  it('samples parse unchanged', () => {
    expect(healthResponseSchema.parse(sampleHealthResponse())).toEqual(sampleHealthResponse());
    expect(authStatusResponseSchema.parse(sampleAuthStatus({ authenticated: false }))).toEqual(
      sampleAuthStatus({ authenticated: false }),
    );
    expect(authExchangeResponseSchema.parse(sampleAuthStatus())).toEqual(sampleAuthStatus());
    expect(launcherCodeResponseSchema.parse(sampleLauncherCode())).toEqual(sampleLauncherCode());
    expect(authExchangeRequestSchema.parse({ code })).toEqual({ code });
    expect(launcherCodeRequestSchema.parse({})).toEqual({});
  });

  it('rejects wrong products, a failed exchange as success and malformed codes', () => {
    expect(healthResponseSchema.safeParse({ ...sampleHealthResponse(), product: 'other' }).success).toBe(
      false,
    );
    expect(authExchangeResponseSchema.safeParse(sampleAuthStatus({ authenticated: false })).success).toBe(
      false,
    );
    expect(authExchangeRequestSchema.safeParse({ code: 'x' }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ ...sampleHealthResponse(), serverInstanceId: 'x' }).success).toBe(
      false,
    );
  });

  it('health carries the backend kind optionally (R3-02, additive: older servers send none)', () => {
    expect(healthResponseSchema.parse({ ...sampleHealthResponse(), backend: 'fake' }).backend).toBe('fake');
    expect(healthResponseSchema.parse(sampleHealthResponse()).backend).toBeUndefined();
    expect(healthResponseSchema.safeParse({ ...sampleHealthResponse(), backend: 'other' }).success).toBe(
      false,
    );
    expect(backendKindSchema.options).toEqual(['sdk', 'fake']);
  });

  it('the HTTP error body is an ErrorPayload; statuses come from the catalog', () => {
    expect(httpErrorBodySchema.parse({ code: 'AUTH_CODE_INVALID' })).toEqual({
      code: 'AUTH_CODE_INVALID',
      params: {},
    });
    expect(errorSpec('AUTH_CODE_INVALID').http).toBe(401);
    expect(errorSpec('LAUNCHER_TOKEN_INVALID').http).toBe(401);
    expect(errorSpec('ORIGIN_REJECTED').http).toBe(403);
  });
});

describe('#code= hand-over', () => {
  it('builds the launcher URL with the code in the hash', () => {
    expect(appUrlWithCode(serverOrigin(4711), code)).toBe(`http://127.0.0.1:4711/#code=${code}`);
  });

  it.each([
    [`#code=${code}`, code, ''],
    [`#code=${code}&session=local:${SAMPLE_IDS.entry}`, code, `#session=local:${SAMPLE_IDS.entry}`],
    [`#session=x&code=${code}`, code, '#session=x'],
    ['#code=broken&session=x', null, '#session=x'],
    ['#code&x=1', null, '#x=1'],
    [`#code=${code}&code=${sampleToken(3)}`, code, ''],
    ['#session=x', null, '#session=x'],
    ['', null, ''],
    ['#', null, ''],
    [`code=${code}`, code, ''],
  ])('%s', (hash, expectedCode, rest) => {
    expect(takeAuthCodeFromHash(hash)).toEqual({ code: expectedCode, hash: rest });
  });

  it('Phase 2: the launcher URL can select a session; the client keeps it after the code', () => {
    const url = appUrlWithCode(serverOrigin(4711), code, { entryId: SAMPLE_IDS.entry });
    expect(url).toBe(`http://127.0.0.1:4711/#code=${code}&${SESSION_HASH_PARAM}=${SAMPLE_IDS.entry}`);
    expect(takeAuthCodeFromHash(url.slice(url.indexOf('#')))).toEqual({
      code,
      hash: `#${SESSION_HASH_PARAM}=${SAMPLE_IDS.entry}`,
    });
  });
});

describe('protocol handler parallax: (Phase 2, ADR-109)', () => {
  it('builds and parses the session URI', () => {
    expect(PROTOCOL_SCHEME).toBe('parallax');
    expect(sessionProtocolUri(SAMPLE_IDS.entry)).toBe(`parallax://session/${SAMPLE_IDS.entry}`);
    expect(parseSessionProtocolUri(sessionProtocolUri(SAMPLE_IDS.entry))).toBe(SAMPLE_IDS.entry);
  });

  it.each([
    [`parallax://session/${SAMPLE_IDS.entry}/`, SAMPLE_IDS.entry],
    [`PARALLAX:session/${SAMPLE_IDS.entry}`, SAMPLE_IDS.entry],
    [`parallax://session/${SAMPLE_IDS.entry}//`, null],
    [`parallax://session/en_123`, null],
    [`parallax://session/${SAMPLE_IDS.entry}?x=1`, null],
    [`parallax://session/${SAMPLE_IDS.entry}" --evil`, null],
    [`parallax://other/${SAMPLE_IDS.entry}`, null],
    [`http://session/${SAMPLE_IDS.entry}`, null],
    ['', null],
  ])('%s → %s', (uri, expected) => {
    expect(parseSessionProtocolUri(uri)).toBe(expected);
  });
});

describe('image upload (Phase 2, ADR-103)', () => {
  it('media types are the SDK image types', () => {
    expect([...ATTACHMENT_MEDIA_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    expect(attachmentMediaTypeSchema.safeParse('image/svg+xml').success).toBe(false);
  });

  it('query: coerces sizes, caps the name', () => {
    expect(attachmentUploadQuerySchema.parse({ name: 'shot.png', width: '1568', height: '980' })).toEqual({
      name: 'shot.png',
      width: 1568,
      height: 980,
    });
    expect(attachmentUploadQuerySchema.parse({})).toEqual({});
    expect(attachmentUploadQuerySchema.safeParse({ width: '0' }).success).toBe(false);
    expect(attachmentUploadQuerySchema.safeParse({ width: 'abc' }).success).toBe(false);
    expect(attachmentUploadQuerySchema.safeParse({ name: 'x'.repeat(261) }).success).toBe(false);
  });

  it('response carries a BlobRef', () => {
    const ok = attachmentUploadResponseSchema.safeParse({
      attachment: {
        blobId: sampleBlobId(2),
        mediaType: 'image/png',
        bytes: 10,
        width: 1,
        height: 1,
        name: null,
      },
    });
    expect(ok.success).toBe(true);
    expect(attachmentUploadResponseSchema.safeParse({ attachment: { blobId: 'x' } }).success).toBe(false);
  });
});

describe('lock file (single instance, C.8)', () => {
  it('parses a valid lock file and rejects a broken token or port', () => {
    expect(SERVER_LOCK_FILE).toBe('server.lock.json');
    expect(serverLockFileSchema.parse(sampleServerLockFile())).toEqual(sampleServerLockFile());
    expect(serverLockFileSchema.safeParse(sampleServerLockFile({ launcherToken: 'x' })).success).toBe(false);
    expect(serverLockFileSchema.safeParse(sampleServerLockFile({ port: 0 })).success).toBe(false);
    expect(serverLockFileSchema.safeParse({ ...sampleServerLockFile(), schemaVersion: 2 }).success).toBe(
      false,
    );
  });
});
