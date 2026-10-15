import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { isoDateTimeSchema } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  API_PATHS,
  AUTH_CODE_TTL_MS,
  AUTH_COOKIE_ATTRIBUTES,
  authCodeSchema,
  authCookieName,
  authExchangeRequestSchema,
  parseBearerToken,
  type AuthExchangeResponse,
  type AuthStatusResponse,
  type LauncherCodeResponse,
  type LauncherToken,
} from '@shared/http';
import { newToken } from '../lib/ids';
import { logger as rootLogger, registerSecret, unregisterSecret } from '../lib/logger';
import { JsonStore, type StoreFs, type StoreWarningSink } from '../store/jsonStore';
import { sendError } from './reply';

/**
 * Auth (A.8, ADR-015, docs/architecture.md §5.1): one-time codes (in memory, single use, TTL,
 * constant-time comparison) → `POST /api/auth` → persistent device cookie `parallax_<port>`
 * (HttpOnly, SameSite=Strict, opaque, HMAC-signed with the rotatable secret in
 * `PARALLAX_HOME/auth-secret.json`). `POST /api/launcher/code` issues new codes for the bearer of
 * the launcher token (lock file, WP-21). Origin/Host/Sec-Fetch-Site are checked by origin.ts.
 */

export const AUTH_SECRET_FILE = 'auth-secret.json';
export const AUTH_SECRET_SCHEMA_VERSION = 1;
/** Outstanding one-time codes kept at most (oldest dropped first). */
export const MAX_PENDING_CODES = 100;

const base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const authSecretFileSchema = z.object({
  schemaVersion: z.literal(AUTH_SECRET_SCHEMA_VERSION),
  secret: base64Url32Schema,
  createdAt: isoDateTimeSchema,
});
export type AuthSecretFile = z.infer<typeof authSecretFileSchema>;

const COOKIE_VERSION = 'v1';

export interface AuthServiceOptions {
  home: string;
  serverInstanceId: string;
  /** Default: a fresh random token (written into the lock file by WP-21). */
  launcherToken?: LauncherToken;
  now?: () => number;
  warnings?: StoreWarningSink;
  fs?: StoreFs;
  logger?: Logger;
}

export interface AuthService {
  readonly serverInstanceId: string;
  /** Secret of `POST /api/launcher/code`; never logged (registered for redaction). */
  readonly launcherToken: LauncherToken;
  /** New one-time code (single use, default TTL `AUTH_CODE_TTL_MS`). */
  issueAuthCode(ttlMs?: number): LauncherCodeResponse;
  /** Consumes a code: true exactly once per issued, unexpired code. */
  exchangeCode(code: string): boolean;
  /** New signed device cookie value. */
  createCookieValue(): string;
  verifyCookieValue(value: string | undefined): boolean;
  /** Is the `Cookie` header carrying a valid device cookie of the server on `port`? */
  isAuthenticated(cookieHeader: string | undefined, port: number): boolean;
  /** Constant-time check of an `Authorization: Bearer <launcherToken>` header. */
  verifyLauncherToken(authorization: string | undefined): boolean;
  /** New secret: every device cookie becomes invalid; listeners close open WebSockets (4401). */
  rotateSecret(): Promise<void>;
  onRevoked(listener: () => void): () => void;
  close(): Promise<void>;
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Value of the `Set-Cookie` header for a device cookie (attributes from @shared/http). */
export function authCookieHeader(port: number, value: string): string {
  // AUTH_COOKIE_ATTRIBUTES: httpOnly true, sameSite 'strict' (literal types; checked by the tests).
  return [
    `${authCookieName(port)}=${value}`,
    `Max-Age=${String(AUTH_COOKIE_ATTRIBUTES.maxAgeSeconds)}`,
    `Path=${AUTH_COOKIE_ATTRIBUTES.path}`,
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ');
}

/** Value of cookie `name` in a `Cookie` request header (first occurrence), or undefined. */
export function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export async function createAuthService(options: AuthServiceOptions): Promise<AuthService> {
  const now = options.now ?? Date.now;
  const log = (options.logger ?? rootLogger).child({ module: 'auth' });
  const store = new JsonStore<AuthSecretFile>({
    file: path.join(options.home, AUTH_SECRET_FILE),
    schema: authSecretFileSchema,
    version: AUTH_SECRET_SCHEMA_VERSION,
    defaults: () => ({
      schemaVersion: AUTH_SECRET_SCHEMA_VERSION,
      secret: newToken(),
      createdAt: new Date(now()).toISOString(),
    }),
    debounceMs: 0,
    warnings: options.warnings,
    fs: options.fs,
    logger: options.logger,
  });
  let secretFile = await store.load();
  // Persist a freshly generated (or restored) secret right away.
  store.set(secretFile);
  await store.flush();
  let secretKey = Buffer.from(secretFile.secret, 'base64url');
  registerSecret(secretFile.secret);

  const launcherToken = options.launcherToken ?? newToken();
  registerSecret(launcherToken);

  const codes = new Map<string, number>();
  const revokedListeners = new Set<() => void>();

  const pruneCodes = () => {
    const t = now();
    for (const [code, expiresAt] of codes) if (expiresAt <= t) codes.delete(code);
  };

  const mac = (payload: string) => createHmac('sha256', secretKey).update(payload).digest('base64url');

  const verifyCookieValue = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const parts = value.split('.');
    if (parts.length !== 4) return false;
    const [version, deviceId, issuedAt, signature] = parts;
    if (
      version !== COOKIE_VERSION ||
      deviceId === undefined ||
      issuedAt === undefined ||
      signature === undefined
    ) {
      return false;
    }
    if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId) || !/^\d{1,12}$/.test(issuedAt)) return false;
    const expected = mac(`${version}.${deviceId}.${issuedAt}`);
    if (!equalStrings(signature, expected)) return false;
    const ageSeconds = now() / 1000 - Number(issuedAt);
    return ageSeconds <= AUTH_COOKIE_ATTRIBUTES.maxAgeSeconds;
  };

  return {
    serverInstanceId: options.serverInstanceId,
    launcherToken,
    issueAuthCode: (ttlMs = AUTH_CODE_TTL_MS) => {
      pruneCodes();
      while (codes.size >= MAX_PENDING_CODES) {
        const oldest = codes.keys().next();
        if (oldest.done === true) break;
        codes.delete(oldest.value);
      }
      const code = newToken();
      const expiresAt = now() + ttlMs;
      codes.set(code, expiresAt);
      return {
        code,
        expiresAt: new Date(expiresAt).toISOString(),
        serverInstanceId: options.serverInstanceId,
      };
    },
    exchangeCode: (code) => {
      if (!authCodeSchema.safeParse(code).success) return false;
      pruneCodes();
      // Compare against every pending code in constant time (no early exit on the key lookup).
      let match: string | null = null;
      for (const candidate of codes.keys()) {
        if (equalStrings(candidate, code)) match = candidate;
      }
      if (match === null) return false;
      codes.delete(match);
      return true;
    },
    createCookieValue: () => {
      const deviceId = randomBytes(16).toString('base64url');
      const issuedAt = String(Math.floor(now() / 1000));
      const payload = `${COOKIE_VERSION}.${deviceId}.${issuedAt}`;
      return `${payload}.${mac(payload)}`;
    },
    verifyCookieValue,
    isAuthenticated: (cookieHeader, port) => {
      if (cookieHeader === undefined || cookieHeader === '') return false;
      return verifyCookieValue(readCookie(cookieHeader, authCookieName(port)));
    },
    verifyLauncherToken: (authorization) => {
      const token = parseBearerToken(authorization);
      return token !== null && equalStrings(token, launcherToken);
    },
    rotateSecret: async () => {
      unregisterSecret(secretFile.secret);
      secretFile = store.set({
        schemaVersion: AUTH_SECRET_SCHEMA_VERSION,
        secret: newToken(),
        createdAt: new Date(now()).toISOString(),
      });
      secretKey = Buffer.from(secretFile.secret, 'base64url');
      registerSecret(secretFile.secret);
      await store.flush();
      log.info('auth secret rotated, all device cookies revoked');
      for (const listener of revokedListeners) listener();
    },
    onRevoked: (listener) => {
      revokedListeners.add(listener);
      return () => {
        revokedListeners.delete(listener);
      };
    },
    close: async () => {
      await store.close();
    },
  };
}

// =====================================================================================
// Routes
// =====================================================================================

export interface AuthRouteContext {
  /** Actual listening port (cookie name). */
  port: () => number;
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthService, ctx: AuthRouteContext): void {
  app.post(API_PATHS.auth, (request, reply) => {
    const body = authExchangeRequestSchema.safeParse(request.body);
    // Unknown, used, expired and malformed codes are indistinguishable on purpose.
    if (!body.success || !auth.exchangeCode(body.data.code))
      return sendError(reply, makeError('AUTH_CODE_INVALID'));
    void reply.header('set-cookie', authCookieHeader(ctx.port(), auth.createCookieValue()));
    const response: AuthExchangeResponse = { authenticated: true, serverInstanceId: auth.serverInstanceId };
    return response;
  });

  app.get(API_PATHS.authStatus, (request) => {
    const response: AuthStatusResponse = {
      authenticated: auth.isAuthenticated(request.headers.cookie, ctx.port()),
      serverInstanceId: auth.serverInstanceId,
    };
    return response;
  });

  app.post(API_PATHS.launcherCode, (request, reply) => {
    if (!auth.verifyLauncherToken(request.headers.authorization)) {
      return sendError(reply, makeError('LAUNCHER_TOKEN_INVALID'));
    }
    return auth.issueAuthCode();
  });
}
