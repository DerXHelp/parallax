import { mkdtemp } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { authCookieName, serverOrigin } from '@shared/http';
import { parseServerMessage, type ClientMessage, type ServerMessage } from '@shared/protocol';
import { createServerInstance, type ServerInstance } from '../config';
import { createBlobStore, type FileBlobStore } from '../store/blobs';
import { createSyncHub, type HubTiming, type SyncHub } from '../sync/hub';
import { createMemorySessionSource, type MemorySessionSource } from '../sync/memorySource';
import { createApp } from './app';
import { createAuthService, type AuthService } from './auth';

/**
 * Test support (not bundled): a real server on 127.0.0.1, port 0, temp PARALLAX_HOME, memory
 * session source, plus a `ws` test client and a raw HTTP helper with full header control.
 * Always `await server.close()` in tests.
 */

export interface TestServer {
  app: FastifyInstance;
  port: number;
  origin: string;
  host: string;
  home: string;
  instance: ServerInstance;
  auth: AuthService;
  blobs: FileBlobStore;
  hub: SyncHub;
  source: MemorySessionSource;
  /** Exchanges a fresh code for a device cookie; returns the `Cookie` header value. */
  login(): Promise<string>;
  close(): Promise<void>;
}

export async function makeTempHome(prefix = 'wp10-'): Promise<string> {
  const base = process.env.PARALLAX_HOME ?? os.tmpdir();
  return mkdtemp(path.join(base, prefix));
}

export async function startTestServer(
  options: { dev?: boolean; timing?: Partial<HubTiming>; home?: string } = {},
): Promise<TestServer> {
  const home = options.home ?? (await makeTempHome());
  const instance = createServerInstance({ serverVersion: '0.0.0-test' });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const blobs = createBlobStore({ home });
  const source = createMemorySessionSource();
  const hub = createSyncHub({ source, instance, timing: { heartbeatMs: 0, ...options.timing } });
  const app = await createApp({ config: { port: 0, dev: options.dev ?? false }, instance, auth, blobs, hub });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address !== 'object') throw new Error('server not listening');
  const port = address.port;
  const origin = serverOrigin(port);

  const server: TestServer = {
    app,
    port,
    origin,
    host: `127.0.0.1:${String(port)}`,
    home,
    instance,
    auth,
    blobs,
    hub,
    source,
    login: async () => {
      const { code } = auth.issueAuthCode();
      const res = await rawRequest(port, {
        method: 'POST',
        path: '/api/auth',
        headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.status !== 200) throw new Error(`login failed: ${String(res.status)} ${res.body}`);
      const cookie = cookieFromSetCookie(res.headers['set-cookie'], authCookieName(port));
      if (cookie === null) throw new Error('login: no cookie');
      return cookie;
    },
    close: async () => {
      await app.close();
      await blobs.close();
      await auth.close();
    },
  };
  return server;
}

/** `name=value` of a Set-Cookie header (for the `Cookie` request header). */
export function cookieFromSetCookie(setCookie: string[] | string | undefined, name: string): string | null {
  const list = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const line of list) {
    const pair = line.split(';')[0]?.trim();
    if (pair?.startsWith(`${name}=`) === true) return pair;
  }
  return null;
}

// ---- raw HTTP (node:http: full control over Host, Origin, Sec-Fetch-Site) ----

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function rawRequest(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

// ---- WebSocket test client ----

export interface WsConnectOptions {
  cookie?: string;
  origin?: string | null;
  site?: string | null;
  host?: string;
}

export type WsConnectResult =
  { ok: true; client: TestWsClient } | { ok: false; status: number; body: string };

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export class TestWsClient {
  /** Every received message, in order. */
  readonly messages: ServerMessage[] = [];
  /** Messages that arrived but are not JSON/schema-valid (should stay empty). */
  readonly invalid: string[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly consumed = new Set<number>();
  private readonly waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];

  constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    socket.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      const parsed = parseServerMessage(text);
      if (parsed.ok !== true) {
        this.invalid.push(text);
        return;
      }
      const index = this.messages.push(parsed.message) - 1;
      const waiterIndex = this.waiters.findIndex((w) => w.match(parsed.message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        this.consumed.add(index);
        waiter?.resolve(parsed.message);
      }
    });
  }

  send(message: ClientMessage | Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** Oldest not yet consumed message of `type` (matching `match`), waiting up to `timeoutMs`. */
  next<T extends ServerMessage['type']>(
    type: T,
    match: (m: MessageOf<T>) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<MessageOf<T>> {
    const isType = (m: ServerMessage): m is MessageOf<T> => m.type === type;
    const isMatch = (m: ServerMessage) => isType(m) && match(m);
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (message !== undefined && !this.consumed.has(i) && isType(message) && match(message)) {
        this.consumed.add(i);
        return Promise.resolve(message);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push({
        match: isMatch,
        resolve: (m) => {
          clearTimeout(timer);
          if (isType(m)) resolve(m);
        },
      });
    });
  }

  /** All received messages of `type` (consumed or not). */
  all<T extends ServerMessage['type']>(type: T): MessageOf<T>[] {
    return this.messages.filter((m): m is MessageOf<T> => m.type === type);
  }

  close(): Promise<{ code: number; reason: string }> {
    this.socket.close();
    return this.closed;
  }
}

export function connectWs(
  server: Pick<TestServer, 'port' | 'origin' | 'host'>,
  options: WsConnectOptions = {},
): Promise<WsConnectResult> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  const origin = options.origin === undefined ? server.origin : options.origin;
  if (origin !== null) headers.origin = origin;
  const site = options.site === undefined ? 'same-origin' : options.site;
  if (site !== null) headers['sec-fetch-site'] = site;
  if (options.host !== undefined) headers.host = options.host;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/api/ws`, { headers });
    const client = new TestWsClient(socket);
    socket.once('open', () => {
      resolve({ ok: true, client });
    });
    socket.once('unexpected-response', (req, res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        req.destroy();
        resolve({ ok: false, status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    // Kept for the socket's lifetime: errors after open/rejection must not become uncaught.
    socket.on('error', (error) => {
      reject(error);
    });
  });
}

/** Connects with a valid cookie, completes the handshake and returns the client. */
export async function connectAndHello(
  server: TestServer,
  cookie: string,
  hello: ClientMessage,
): Promise<TestWsClient> {
  const result = await connectWs(server, { cookie });
  if (!result.ok) throw new Error(`ws rejected: ${String(result.status)} ${result.body}`);
  await result.client.next('hello');
  result.client.send(hello);
  await result.client.next('summaries.snapshot');
  return result.client;
}
