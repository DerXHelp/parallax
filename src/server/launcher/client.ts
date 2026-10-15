/**
 * Launcher → server over HTTP (architecture §5.1 (h)/(i), ADR-015): `GET /api/health` for the
 * single-instance check and `POST /api/launcher/code` (Bearer launcher token, WITHOUT Origin) for a
 * one-time code. Plain `node:http` on 127.0.0.1 – no proxy settings, no keep-alive, no Origin or
 * Sec-Fetch-Site header (the server accepts the launcher endpoint only without them).
 */
import { request } from 'node:http';
import {
  API_PATHS,
  LOOPBACK_HOST,
  bearerAuthorization,
  healthResponseSchema,
  launcherCodeResponseSchema,
  type HealthResponse,
  type LauncherCodeResponse,
  type LauncherToken,
  type ServerLockFile,
} from '@shared/http';
import { errnoCode } from '../lib/process';
import { readServerLock, type ReadText } from './lockFile';

export interface HttpJsonRequest {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
}

export interface HttpJsonResponse {
  status: number;
  /** Parsed JSON body, or null if the body is empty or not JSON. */
  body: unknown;
}

/** Rejects on connection errors (`code` ECONNREFUSED, ECONNRESET …) and with `code: 'ETIMEDOUT'`. */
export type HttpJson = (request: HttpJsonRequest) => Promise<HttpJsonResponse>;

const MAX_RESPONSE_BYTES = 64 * 1024;

class HttpTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(ms: number) {
    super(`no answer within ${String(ms)} ms`);
    this.name = 'HttpTimeoutError';
  }
}

/** Real client: one connection per request to 127.0.0.1:<port>. */
export const nodeHttpJson: HttpJson = (options) =>
  new Promise<HttpJsonResponse>((resolve, reject) => {
    const req = request(
      {
        host: LOOPBACK_HOST,
        port: options.port,
        method: options.method,
        path: options.path,
        headers: { accept: 'application/json', ...options.headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        });
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = text === '' ? null : (JSON.parse(text) as unknown);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new HttpTimeoutError(options.timeoutMs));
    }, options.timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(options.body);
  });

/** Default timeout of one health ping (a running server answers in a few ms). */
export const HEALTH_TIMEOUT_MS = 2_000;

export type HealthCheck =
  | { kind: 'ok'; health: HealthResponse }
  /** Nothing listens (ECONNREFUSED), no answer in time, or the connection broke. */
  | { kind: 'down'; reason: string }
  /** Something answers on the port, but not a Parallax health response. */
  | { kind: 'foreign'; status: number };

export async function checkHealth(
  port: number,
  options: { http?: HttpJson; timeoutMs?: number } = {},
): Promise<HealthCheck> {
  const http = options.http ?? nodeHttpJson;
  try {
    const res = await http({
      port,
      method: 'GET',
      path: API_PATHS.health,
      timeoutMs: options.timeoutMs ?? HEALTH_TIMEOUT_MS,
    });
    const parsed = healthResponseSchema.safeParse(res.body);
    if (res.status === 200 && parsed.success) return { kind: 'ok', health: parsed.data };
    return { kind: 'foreign', status: res.status };
  } catch (error) {
    return { kind: 'down', reason: errnoCode(error) ?? 'error' };
  }
}

export type LauncherCodeResult =
  | { kind: 'ok'; response: LauncherCodeResponse }
  /** 401 LAUNCHER_TOKEN_INVALID: the token is not the running server's (foreign/stale lock file). */
  | { kind: 'token_invalid' }
  | { kind: 'failed'; reason: string };

/** `POST /api/launcher/code` with the token from the lock file (body `{}`, no Origin). */
export async function requestLauncherCode(
  port: number,
  token: LauncherToken,
  options: { http?: HttpJson; timeoutMs?: number } = {},
): Promise<LauncherCodeResult> {
  const http = options.http ?? nodeHttpJson;
  try {
    const res = await http({
      port,
      method: 'POST',
      path: API_PATHS.launcherCode,
      headers: { authorization: bearerAuthorization(token), 'content-type': 'application/json' },
      body: '{}',
      timeoutMs: options.timeoutMs ?? HEALTH_TIMEOUT_MS,
    });
    if (res.status === 401) return { kind: 'token_invalid' };
    const parsed = launcherCodeResponseSchema.safeParse(res.body);
    if (res.status === 200 && parsed.success) return { kind: 'ok', response: parsed.data };
    return { kind: 'failed', reason: `HTTP ${String(res.status)}` };
  } catch (error) {
    return { kind: 'failed', reason: errnoCode(error) ?? 'error' };
  }
}

export type RunningServerCheck =
  | { kind: 'running'; lock: ServerLockFile; health: HealthResponse }
  | {
      kind: 'none';
      /**
       * `no_lock` – no lock file; `invalid_lock` – unreadable/other schema (stale);
       * `unreachable` – nothing answers on the lock's port (crashed server, stale);
       * `other_instance` – a different server (instance UUID) answers on that port;
       * `foreign` – something that is not Parallax answers on that port.
       */
      reason: 'no_lock' | 'invalid_lock' | 'unreachable' | 'other_instance' | 'foreign';
      /** The stale lock (for messages, e.g. the PID of a hanging server). */
      staleLock: ServerLockFile | null;
    };

/**
 * Single-instance check (C.8): lock file → health ping → same instance UUID? Never trusts the PID.
 * A stale lock file is left in place; the next server overwrites it after `listen`.
 */
export async function findRunningServer(options: {
  home: string;
  health?: (port: number) => Promise<HealthCheck>;
  read?: ReadText;
}): Promise<RunningServerCheck> {
  const health = options.health ?? ((port: number) => checkHealth(port));
  const read = await readServerLock(options.home, options.read);
  if (read.kind === 'missing') return { kind: 'none', reason: 'no_lock', staleLock: null };
  if (read.kind === 'invalid') return { kind: 'none', reason: 'invalid_lock', staleLock: null };
  const { lock } = read;
  const check = await health(lock.port);
  if (check.kind === 'down') return { kind: 'none', reason: 'unreachable', staleLock: lock };
  if (check.kind === 'foreign') return { kind: 'none', reason: 'foreign', staleLock: lock };
  if (check.health.serverInstanceId !== lock.serverInstanceId) {
    return { kind: 'none', reason: 'other_instance', staleLock: lock };
  }
  return { kind: 'running', lock, health: check.health };
}
