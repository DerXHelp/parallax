import { describe, expect, it } from 'vitest';
import { errorSpec } from './errors';
import {
  API_PATHS,
  API_PREFIX,
  AUTH_CODE_TTL_MS,
  AUTH_COOKIE_ATTRIBUTES,
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_TOKEN_BYTES,
  DEV_AUTH_CODE_TTL_MS,
  DEV_WEB_PORT,
  LOOPBACK_HOST,
  SERVER_LOCK_FILE,
  allowedHosts,
  allowedOrigins,
  appUrlWithCode,
  authCodeSchema,
  authCookieName,
  authExchangeRequestSchema,
  authExchangeResponseSchema,
  authStatusResponseSchema,
  bearerAuthorization,
  blobPath,
  healthResponseSchema,
  httpErrorBodySchema,
  launcherCodeRequestSchema,
  launcherCodeResponseSchema,
  launcherTokenSchema,
  parseBearerToken,
  serverLockFileSchema,
  serverOrigin,
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
