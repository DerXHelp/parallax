/**
 * WP-13 §5.2 "WS-Ende-zu-Ende" (safety net for WP-20): the real WP-10 hub and app on 127.0.0.1:0
 * with a temp PARALLAX_HOME, the SessionManager as `SessionSource`, FakeBackend and memory stores.
 * subscribe → snapshot, live ops, cmd/ack, reconnect with sinceSeq (replay). The hub validates
 * every op/summary/snapshot (`validation: 'throw'` under Vitest).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { serverOrigin } from '@shared/http';
import { PROTOCOL_VERSION, type ServerMessage } from '@shared/protocol';
import { sampleId } from '@shared/samples';
import { createFakeBackend } from '../backend/fakeBackend';
import { createFakeClaudeIntegration } from '../backend/fake/integration';
import { createServerInstance } from '../config';
import { createApp } from '../http/app';
import { createAuthService } from '../http/auth';
import {
  connectWs,
  cookieFromSetCookie,
  makeTempHome,
  rawRequest,
  type TestWsClient,
} from '../http/testServer';
import { authCookieName } from '@shared/http';
import { createSyncHub } from '../sync/hub';
import { createSessionManager, type SessionManager } from './manager';
import { createMemoryProcessStore } from './processStore';
import { createMemoryStores } from './testing/memoryStores';

// Whole-engine runs: generous per-test bound for parallel load (the logic itself uses no wall clock).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

interface Running {
  port: number;
  origin: string;
  host: string;
  cookie: string;
  manager: SessionManager;
  close(): Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(): Promise<Running> {
  const home = await makeTempHome('wp13b-ws-');
  const instance = createServerInstance({ serverVersion: '0.0.0-test' });
  const auth = await createAuthService({ home, serverInstanceId: instance.serverInstanceId });
  const stores = { ...createMemoryStores(), processes: createMemoryProcessStore() };
  const backend = createFakeBackend({ speed: 0 });
  const manager = createSessionManager({
    backend,
    claude: createFakeClaudeIntegration(),
    stores,
    host: {
      serverVersion: '0.0.0-test',
      sdkVersion: '0.3.296',
      sdkClaudeCodeVersion: '2.1.296',
      platform: process.platform,
      dataDirLabel: 'test',
      dev: true,
    },
    checkCwd: () => Promise.resolve(),
    gitBranch: () => Promise.resolve(null),
    options: { contextRefreshDelayMs: 0 },
  });
  const hub = createSyncHub({ source: manager, instance, timing: { heartbeatMs: 0, summaryThrottleMs: 20 } });
  manager.attachPublisher(hub);
  await manager.start();
  const app = await createApp({ config: { port: 0, dev: false }, instance, auth, blobs: stores.blobs, hub });
  await app.listen({ host: '127.0.0.1', port: 0 });
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
  if (cookie === null) throw new Error(`login failed: ${String(login.status)}`);
  const close = async () => {
    await manager.shutdown();
    await app.close();
    await auth.close();
  };
  cleanups.push(close);
  return { port, origin, host: `127.0.0.1:${String(port)}`, cookie, manager, close };
}

async function hello(server: Running, clientN = 1): Promise<TestWsClient> {
  const result = await connectWs(server, { cookie: server.cookie });
  if (!result.ok) throw new Error(`ws rejected: ${String(result.status)}`);
  const client = result.client;
  cleanups.push(async () => {
    if (client.socket.readyState === client.socket.OPEN) await client.close();
  });
  await client.next('hello');
  client.send({
    type: 'clientHello',
    protocolVersion: PROTOCOL_VERSION,
    buildId: 'dev',
    clientId: sampleId('cl', clientN),
    presence: { focused: true, visible: true, viewingEntryId: null, typing: false },
  });
  await client.next('host.state');
  await client.next('summaries.snapshot');
  return client;
}

let cmdCounter = 0;
async function command(
  client: TestWsClient,
  cmd: Record<string, unknown>,
): Promise<Extract<ServerMessage, { type: 'ack' }>> {
  cmdCounter += 1;
  const cmdId = `00000000-0000-4000-8000-${cmdCounter.toString(16).padStart(12, '0')}`;
  client.send({ type: 'cmd', cmdId, cmd });
  return client.next('ack', (m) => m.cmdId === cmdId, 10_000);
}

function lastSeq(client: TestWsClient, entryId: EntryId): number {
  let seq = 0;
  for (const m of client.all('session.snapshot')) if (m.entryId === entryId) seq = Math.max(seq, m.seq);
  for (const m of client.all('session.ops')) {
    if (m.entryId !== entryId) continue;
    for (const op of m.ops) seq = Math.max(seq, op.seq);
  }
  return seq;
}

describe('WS end to end (hub + manager + FakeBackend)', () => {
  it('create → subscribe → snapshot + live ops → ack; reconnect with sinceSeq replays', async () => {
    const server = await startServer();
    const client = await hello(server);
    const created = await command(client, {
      name: 'session.create',
      cwd: 'D:\\work\\ws',
      prompt: { text: 'hello over ws' },
    });
    if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
    const result = created.result;
    if (
      typeof result !== 'object' ||
      result === null ||
      !('entryId' in result) ||
      typeof result.entryId !== 'string'
    )
      throw new Error('no entryId');
    const entryId = result.entryId;
    await client.next(
      'summary.upsert',
      (m) => m.summary.entryId === entryId && m.summary.status.runState === 'idle',
      10_000,
    );

    client.send({ type: 'subscribe', entryId });
    const snapshot = await client.next('session.snapshot', (m) => m.entryId === entryId, 10_000);
    expect(snapshot.items.some((i) => i.kind === 'user_message')).toBe(true);
    expect(snapshot.items.some((i) => i.kind === 'assistant_text' && i.text.includes('hello over ws'))).toBe(
      true,
    );
    expect(snapshot.detail.models?.length).toBeGreaterThan(0);

    // Live ops for a second prompt (seq continues after the snapshot).
    const sent = await command(client, { name: 'session.sendPrompt', entryId, prompt: { text: 'second' } });
    expect(sent.ok).toBe(true);
    const live = await client.next('session.ops', (m) => m.entryId === entryId, 10_000);
    expect(live.ops[0]?.seq).toBe(snapshot.seq + 1);
    await client.next(
      'session.ops',
      (m) =>
        m.entryId === entryId &&
        m.ops.some((o) => o.op.op === 'item.upsert' && o.op.item.kind === 'user_message'),
      10_000,
    );
    await client.next(
      'summary.upsert',
      (m) =>
        m.summary.entryId === entryId &&
        m.summary.status.runState === 'idle' &&
        m.summary.status.lastTurn !== null,
      10_000,
    );
    const seq = lastSeq(client, entryId);
    await client.close();

    // Reconnect within the same server instance: replay from sinceSeq (no snapshot), gap-free.
    const again = await hello(server, 2);
    again.send({ type: 'subscribe', entryId, sinceSeq: seq });
    const replay = await again.next('session.ops', (m) => m.entryId === entryId, 10_000);
    let expected = seq;
    for (const op of replay.ops) expect(op.seq).toBe((expected += 1));
    expect(again.all('session.snapshot')).toEqual([]);
    const third = await command(again, { name: 'session.sendPrompt', entryId, prompt: { text: 'third' } });
    expect(third.ok).toBe(true);
    const after = await again.next('session.ops', (m) => m.entryId === entryId && m.ops.length > 0, 10_000);
    expect(after.ops[0]?.seq).toBe(expected + 1);

    // A command error comes back as ack{ok:false}.
    const bad = await command(again, { name: 'session.resume', entryId: sampleId('en', 404) });
    expect(bad).toMatchObject({ ok: false, error: { code: 'ENTRY_NOT_FOUND' } });
    expect(client.invalid).toEqual([]);
    expect(again.invalid).toEqual([]);
  });
});
