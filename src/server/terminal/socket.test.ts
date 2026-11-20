/**
 * The terminal route against a real server (port 0) and a real `ws` client: hello flow, close codes,
 * invalid messages, binary output frames, the second guard line and `onRevoked`.
 */
import fastifyWebsocket from '@fastify/websocket';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { makeError, type ErrorPayload } from '@shared/errors';
import { API_PATHS } from '@shared/http';
import { DEFAULT_CONSOLE_SETTINGS } from '@shared/model';
import { SAMPLE_IDS, sampleId } from '@shared/samples';
import {
  TERMINAL_CLOSE_CODES,
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalFrame,
  terminalServerMessageSchema,
  type TerminalServerMessage,
} from '@shared/terminal';
import { rawUpgrade } from '../http/testServer';
import { sleep } from '../lib/async';
import { createLogger } from '../lib/logger';
import { createFakePtyFactory } from './fakePty';
import type { TerminalService } from './ports';
import { createTerminalService } from './service';
import { TERMINAL_SOCKET_LIMITS, registerTerminalRoute, type TerminalRouteOptions } from './socket';

const ENTRY = SAMPLE_IDS.entry;
const CWD = 'D:\\Projects\\demo';
const SILENT = createLogger({ level: 'silent' });

let app: FastifyInstance | null = null;
let service: TerminalService | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await service?.closeAll();
  service = null;
  await app?.close();
  app = null;
});

async function start(
  options: Partial<Pick<TerminalRouteOptions, 'authorize' | 'onRevoked' | 'timing'>> = {},
) {
  const server = fastify();
  app = server;
  await server.register(fastifyWebsocket);
  const terminals = createTerminalService({
    pty: createFakePtyFactory(),
    entry: (id) => (id === ENTRY ? { cwd: CWD, archived: false } : null),
    settings: () => DEFAULT_CONSOLE_SETTINGS,
    logger: SILENT,
    checkCwd: () => Promise.resolve(),
    launch: () => Promise.resolve({ executablePath: 'C:\\Windows\\System32\\cmd.exe', args: [], env: {} }),
  });
  service = terminals;
  const route = registerTerminalRoute(server, {
    service: terminals,
    authorize: options.authorize ?? (() => null),
    ...(options.onRevoked === undefined ? {} : { onRevoked: options.onRevoked }),
    logger: SILENT,
    timing: { heartbeatMs: 0, helloTimeoutMs: 300, ...options.timing },
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (address === null || typeof address !== 'object') throw new Error('not listening');
  return { port: address.port, route };
}

interface Client {
  ws: WebSocket;
  messages: TerminalServerMessage[];
  frames: { channel: number; text: string }[];
  closed: Promise<number>;
  send(message: unknown): void;
  text(channel: number): string;
  errors(): ErrorPayload[];
}

async function connect(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${API_PATHS.terminalWs}`);
  sockets.push(ws);
  const messages: TerminalServerMessage[] = [];
  const frames: { channel: number; text: string }[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const frame = decodeTerminalFrame(new Uint8Array(data));
      if (frame !== null)
        frames.push({ channel: frame.channel, text: Buffer.from(frame.data).toString('utf8') });
      return;
    }
    const json: unknown = JSON.parse(data.toString('utf8'));
    messages.push(terminalServerMessageSchema.parse(json));
  });
  ws.on('error', () => undefined);
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => {
      resolve(code);
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('close', () => {
      reject(new Error('closed before open'));
    });
  });
  return {
    ws,
    messages,
    frames,
    closed,
    send: (message) => {
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    },
    text: (channel) =>
      frames
        .filter((f) => f.channel === channel)
        .map((f) => f.text)
        .join(''),
    errors: () => messages.flatMap((m) => (m.type === 'error' ? [m.error] : [])),
  };
}

const hello = (entryId: string = ENTRY, protocol: number = TERMINAL_PROTOCOL_VERSION) => ({
  type: 'hello',
  protocol,
  entryId,
});

describe('registerTerminalRoute (WP-99)', () => {
  it('runs hello, open, attach and input with binary output frames', async () => {
    const { port, route } = await start();
    const client = await connect(port);
    client.send(hello());
    await vi.waitFor(() => {
      expect(client.messages.map((m) => m.type)).toEqual(['welcome', 'terminals']);
    });
    expect(client.messages[0]).toMatchObject({ available: true, error: null });
    client.send({ type: 'open', requestId: 'r1', shell: 'cmd', cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(client.messages.some((m) => m.type === 'opened')).toBe(true);
    });
    const opened = client.messages.find((m) => m.type === 'opened');
    if (opened?.type !== 'opened') throw new Error('no opened');
    const terminalId = opened.terminal.terminalId;
    client.send({ type: 'attach', terminalId, cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(client.messages.find((m) => m.type === 'attached')).toEqual({
        type: 'attached',
        terminalId,
        channel: 0,
      });
      expect(client.text(0)).toBe(`${CWD}>`);
    });
    client.send({ type: 'input', terminalId, data: 'echo hi\r' });
    await vi.waitFor(() => {
      expect(client.text(0)).toBe(`${CWD}>echo hi\r\nhi\r\n${CWD}>`);
    });
    expect(route.connections()).toBe(1);
    client.send({ type: 'close', terminalId });
    await vi.waitFor(() => {
      expect(client.messages.at(-1)).toEqual({ type: 'terminals', items: [] });
    });
    expect(client.messages.at(-2)).toEqual({ type: 'exit', terminalId, exitCode: null, reason: 'closed' });
    client.ws.close();
    await client.closed;
    await vi.waitFor(() => {
      expect(route.connections()).toBe(0);
    });
  });

  it('closes 4400 without hello in time', async () => {
    const { port } = await start({ timing: { helloTimeoutMs: 50 } });
    const client = await connect(port);
    expect(await client.closed).toBe(TERMINAL_CLOSE_CODES.invalid);
    expect(client.messages).toEqual([]);
  });

  it('closes 4400 when the first message is not hello', async () => {
    const { port } = await start();
    const client = await connect(port);
    client.send({ type: 'detach', terminalId: `tm_${'0'.repeat(32)}` });
    expect(await client.closed).toBe(TERMINAL_CLOSE_CODES.invalid);
    expect(client.errors()).toEqual([makeError('INVALID_MESSAGE', { reason: 'hello_required' })]);
  });

  it('closes 4426 on another protocol and 4404 for an unknown entry', async () => {
    const { port } = await start();
    const old = await connect(port);
    old.send(hello(ENTRY, TERMINAL_PROTOCOL_VERSION + 1));
    expect(await old.closed).toBe(TERMINAL_CLOSE_CODES.protocol);
    const stranger = await connect(port);
    stranger.send(hello(sampleId('en', 7)));
    expect(await stranger.closed).toBe(TERMINAL_CLOSE_CODES.entryNotFound);
    expect(stranger.messages).toEqual([]);
  });

  it('answers invalid messages with INVALID_MESSAGE and closes 4400 after more than 10', async () => {
    const { port } = await start();
    const client = await connect(port);
    client.send(hello());
    await vi.waitFor(() => {
      expect(client.messages).toHaveLength(2);
    });
    client.ws.send(Buffer.from([0, 1, 2]));
    client.send('{not json');
    client.send({ type: 'resize', terminalId: 'nope', cols: 1, rows: 1 });
    client.send(hello());
    client.send({
      type: 'input',
      terminalId: `tm_${'0'.repeat(32)}`,
      data: 'x'.repeat(TERMINAL_SOCKET_LIMITS.maxMessageBytes),
    });
    await vi.waitFor(() => {
      expect(client.errors().map((e) => e.params.reason)).toEqual([
        'binary',
        'json',
        'schema',
        'duplicate_hello',
        'too_large',
      ]);
    });
    for (let i = 0; i < 5; i += 1) client.send('[]');
    await sleep(50);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.send('[]');
    expect(await client.closed).toBe(TERMINAL_CLOSE_CODES.invalid);
  });

  it('closes every socket 4401 when the sign-in is revoked', async () => {
    const listeners = new Set<() => void>();
    const { port } = await start({
      onRevoked: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const waiting = await connect(port);
    const bound = await connect(port);
    bound.send(hello());
    await vi.waitFor(() => {
      expect(bound.messages).toHaveLength(2);
    });
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener();
    expect(await waiting.closed).toBe(TERMINAL_CLOSE_CODES.unauthorized);
    expect(await bound.closed).toBe(TERMINAL_CLOSE_CODES.unauthorized);
    await app?.close();
    app = null;
    expect(listeners.size).toBe(0);
  });

  it('pings open sockets', async () => {
    const { port } = await start({ timing: { heartbeatMs: 20 } });
    const client = await connect(port);
    await new Promise<void>((resolve) => {
      client.ws.once('ping', () => {
        resolve();
      });
    });
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('answers the authorizer error over HTTP and terminates a socket that slipped past the hook', async () => {
    const denied = await start({ authorize: () => makeError('AUTH_REQUIRED') });
    const res = await rawUpgrade(denied.port, API_PATHS.terminalWs);
    expect(res.status).toBe(401);
    expect(res.text).toContain('"code":"AUTH_REQUIRED"');
    await app?.close();
    app = null;
    await service?.closeAll();
    service = null;

    let calls = 0;
    // preValidation passes, the check inside the WS handler fails (simulated bypassed hook).
    const bypassed = await start({ authorize: () => (++calls === 1 ? null : makeError('AUTH_REQUIRED')) });
    const ws = new WebSocket(`ws://127.0.0.1:${String(bypassed.port)}${API_PATHS.terminalWs}`);
    sockets.push(ws);
    ws.on('error', () => undefined);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (closeCode) => {
        resolve(closeCode);
      });
    });
    expect(code).toBe(1006);
    expect(calls).toBe(2);
    expect(bypassed.route.connections()).toBe(0);
  });
});
