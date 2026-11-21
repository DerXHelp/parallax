/**
 * WP-107 (E3, docs/wp/WP-76.md §B.13): the embedded terminal of another computer through the
 * forwarder – browser → `/api/hosts/:hostId/terminal/ws` → `REMOTE_PATHS.terminalWs` of the coupling
 * → the terminal service of the sharing computer (fake pty). Real TLS coupling on 127.0.0.1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { authCookieName, hostTerminalWsPath, serverOrigin } from '@shared/http';
import { DEFAULT_CONSOLE_SETTINGS, remoteEventSchema } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import {
  TERMINAL_PROTOCOL_VERSION,
  decodeTerminalFrame,
  terminalServerMessageSchema,
  type TerminalServerMessage,
} from '@shared/terminal';
import { createServerInstance } from '../config';
import { startControl, startSharing, type ControlSide, type SharingSide } from '../hosts/testKit';
import { createLogger } from '../lib/logger';
import { createBlobStore } from '../store/blobs';
import { createFakePtyFactory } from '../terminal/fakePty';
import type { TerminalService } from '../terminal/ports';
import { createTerminalService } from '../terminal/service';
import { createApp } from './app';
import { createAuthService } from './auth';
import { cookieFromSetCookie, makeTempHome, rawRequest } from './testServer';

// Two servers, a TLS coupling and a fake pty: generous limits for a busy machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENTRY = SAMPLE_IDS.entry;
const CWD = 'D:\\Projects\\demo';
const SECRET_INPUT = 'echo private-input-7731';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
  port: number;
  origin: string;
  cookie: string;
  hostId: string;
  sharing: SharingSide;
  control: ControlSide;
  terminals: TerminalService;
  logs: string[];
}

async function setup(): Promise<Setup> {
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', destination: { write: (line: string) => logs.push(line) } });
  const terminals = createTerminalService({
    pty: createFakePtyFactory(),
    entry: (id) => (id === ENTRY ? { cwd: CWD, archived: false } : null),
    settings: () => DEFAULT_CONSOLE_SETTINGS,
    logger,
    checkCwd: () => Promise.resolve(),
    launch: () => Promise.resolve({ executablePath: 'C:\\Windows\\System32\\cmd.exe', args: [], env: {} }),
  });
  cleanups.push(() => terminals.closeAll());
  const sharing = await startSharing({ terminal: terminals, logger });
  cleanups.push(() => sharing.close());
  const control = await startControl();
  cleanups.push(() => control.close());
  const hostId = await control.add(sharing);
  await control.waitFor(hostId, 'connected');

  const home = await makeTempHome('wp107-terminal-');
  const instance = createServerInstance({ serverVersion: control.version });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const blobs = createBlobStore({ home });
  const app = await createApp({
    config: { port: 0, dev: false },
    instance,
    auth,
    blobs,
    hosts: control.service,
    webRoot: null,
    logger,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(async () => {
    await app.close();
    await blobs.close();
    await auth.close();
  });
  const address = app.server.address();
  if (address === null || typeof address !== 'object') throw new Error('not listening');
  const port = address.port;
  const origin = serverOrigin(port);
  const { code } = auth.issueAuthCode();
  const login = await rawRequest(port, {
    method: 'POST',
    path: '/api/auth',
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const cookie = cookieFromSetCookie(login.headers['set-cookie'], authCookieName(port));
  if (cookie === null) throw new Error('login failed');
  return { port, origin, cookie, hostId, sharing, control, terminals, logs };
}

interface Client {
  ws: WebSocket;
  messages: TerminalServerMessage[];
  closed: Promise<number>;
  send(message: unknown): void;
  text(): string;
}

function connect(
  s: Setup,
  options: { hostId?: string; cookie?: string | null } = {},
): Promise<Client | number> {
  const headers: Record<string, string> = { origin: s.origin, host: `127.0.0.1:${String(s.port)}` };
  const cookie = options.cookie === undefined ? s.cookie : options.cookie;
  if (cookie !== null) headers.cookie = cookie;
  const ws = new WebSocket(
    `ws://127.0.0.1:${String(s.port)}${hostTerminalWsPath(options.hostId ?? s.hostId)}`,
    {
      headers,
    },
  );
  cleanups.push(() => {
    ws.terminate();
  });
  const messages: TerminalServerMessage[] = [];
  const output: string[] = [];
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (binary) {
      const frame = decodeTerminalFrame(new Uint8Array(data));
      if (frame !== null) output.push(Buffer.from(frame.data).toString('utf8'));
      return;
    }
    messages.push(terminalServerMessageSchema.parse(JSON.parse(data.toString('utf8'))));
  });
  ws.on('error', () => undefined);
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => {
      resolve(code);
    });
  });
  return new Promise((resolve) => {
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
    });
    ws.once('open', () => {
      resolve({
        ws,
        messages,
        closed,
        send: (message) => {
          ws.send(JSON.stringify(message));
        },
        text: () => output.join(''),
      });
    });
  });
}

async function client(s: Setup): Promise<Client> {
  const result = await connect(s);
  if (typeof result === 'number') throw new Error(`upgrade refused: ${String(result)}`);
  return result;
}

/** hello → open → attach; resolves with the terminal id. */
async function openTerminal(c: Client): Promise<string> {
  c.send({ type: 'hello', protocol: TERMINAL_PROTOCOL_VERSION, entryId: ENTRY });
  await vi.waitFor(() => {
    expect(c.messages.map((m) => m.type)).toEqual(['welcome', 'terminals']);
  });
  c.send({ type: 'open', requestId: 'r1', shell: 'cmd', cols: 80, rows: 24 });
  let terminalId = '';
  await vi.waitFor(() => {
    const opened = c.messages.find((m) => m.type === 'opened');
    if (opened?.type !== 'opened') throw new Error('not opened yet');
    terminalId = opened.terminal.terminalId;
  });
  c.send({ type: 'attach', terminalId, cols: 80, rows: 24 });
  await vi.waitFor(() => {
    expect(c.text()).toBe(`${CWD}>`);
  });
  return terminalId;
}

async function events(s: Setup): Promise<string[]> {
  const result = (await s.sharing.harness.command({ name: 'remoteAccess.events', onlyRejected: false })) as {
    events: unknown[];
  };
  return result.events.map((event) => remoteEventSchema.parse(event).kind);
}

describe('terminal of another computer through the forwarder (WP-107, E3)', () => {
  it('runs the local protocol end to end; the open is logged over there, the input never', async () => {
    const s = await setup();
    const c = await client(s);
    const terminalId = await openTerminal(c);
    c.send({ type: 'input', terminalId, data: `${SECRET_INPUT}\r` });
    await vi.waitFor(() => {
      expect(c.text()).toContain('private-input-7731\r\n');
    });
    expect(s.terminals.list(ENTRY)).toHaveLength(1);
    expect(s.sharing.harness.service.terminalConnections()).toBe(1);
    await vi.waitFor(async () => {
      expect(await events(s)).toContain('terminal_opened');
    });
    expect(s.logs.join('')).not.toContain('private-input-7731');
  });

  it('unpairing ends the remote terminal and its socket; a local terminal stays', async () => {
    const s = await setup();
    const local = await s.terminals.openClaude(
      ENTRY,
      { executablePath: 'C:\\Windows\\System32\\cmd.exe', args: [], env: {} },
      'local',
    );
    expect('code' in local).toBe(false);
    const c = await client(s);
    await openTerminal(c);
    expect(s.terminals.list(ENTRY)).toHaveLength(2);
    await s.sharing.harness.command({ name: 'remoteAccess.unpair' });
    expect(await c.closed).not.toBe(1000);
    await vi.waitFor(() => {
      expect(s.terminals.list(ENTRY)).toHaveLength(1);
    });
  });

  it('guard: an unknown computer is HOST_NOT_FOUND, a browser without cookie is refused', async () => {
    const s = await setup();
    expect(await connect(s, { hostId: 'pc-unknown' })).toBe(404);
    expect(await connect(s, { cookie: null })).toBe(401);
    expect(s.terminals.list(ENTRY)).toEqual([]);
  });
});
