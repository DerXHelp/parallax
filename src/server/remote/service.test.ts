import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { REMOTE_PATHS, remoteHealthResponseSchema } from '@shared/http';
import { remoteAccessStateSchema } from '@shared/model';
import { PROTOCOL_VERSION, WS_CLOSE } from '@shared/protocol';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { createMemoryKeyStore } from '../secure/memoryKeyStore';
import { PinnedConnectionError, REMOTE_WS_CLIENT_OPTIONS, remoteVersionHeaders } from '../secure/pinnedAgent';
import { TEST_HOST } from '../secure/testKit';
import { CommandError } from '../sync/ports';
import { REMOTE_DIR } from './eventLog';
import { GuardedHubSocket } from './hubSocket';
import { PEER_FILE, createPeerStore } from './peerStore';
import { SHARE_CONFIG, TEST_VERSION, agentRequest, startHarness, type Harness } from './testKit';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

async function commandError(promise: Promise<unknown>): Promise<CommandError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error('expected a CommandError');
}

function openWebSocket(
  agent: ReturnType<Harness['agent']>,
  port: number,
  headers = remoteVersionHeaders(TEST_VERSION),
) {
  return new WebSocket(`wss://${TEST_HOST}:${String(port)}${REMOTE_PATHS.ws}`, {
    agent,
    ...REMOTE_WS_CLIENT_OPTIONS,
    headers,
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data: Buffer) => {
      resolve(data.toString('utf8'));
    });
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve(1006);
    ws.once('close', (code: number) => {
      resolve(code);
    });
  });
}

describe('remote access service', () => {
  it('pairs, then health and the hub WebSocket work through the pinned agent', async () => {
    const h = await harness();
    const paired = await h.pair();
    expect(paired.hostName).toBe('PC-B');
    const state = remoteAccessStateSchema.parse(h.service.state());
    expect(state).toMatchObject({
      listening: true,
      hostName: 'PC-B',
      addresses: [TEST_HOST],
      pairingExpiresAt: null,
      error: null,
    });
    expect(state.peer).toMatchObject({ name: 'PC-A', connected: false, compatible: true });

    const agent = h.agent(paired);
    const health = await agentRequest(agent, h.port(), REMOTE_PATHS.health);
    expect(health.status).toBe(200);
    expect(remoteHealthResponseSchema.parse(JSON.parse(health.body))).toEqual({
      appVersion: TEST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      buildId: 'test',
      hostName: 'PC-B',
      serverInstanceId: h.instance.serverInstanceId,
    });

    const ws = openWebSocket(agent, h.port());
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send('hello');
    expect(await nextMessage(ws)).toBe('echo:hello');
    expect(h.hub.sockets).toHaveLength(1);
    expect(h.hub.sockets[0]?.info.address).toBe(TEST_HOST);
    expect(h.hub.sockets[0]?.socket).toBeInstanceOf(GuardedHubSocket);
    expect(h.service.isCurrentConnection(h.hub.sockets[0]?.socket ?? {})).toBe(true);
    expect(h.service.state()?.peer).toMatchObject({
      connected: true,
      connections: 1,
      appVersion: TEST_VERSION,
    });
    const kinds = h.service.commands.handle(
      { name: 'remoteAccess.events', onlyRejected: false },
      { clientId: 'cl_00000000000000000000000000000001', cmdId: 'x' },
    );
    expect(((await kinds) as { events: { kind: string }[] }).events.map((event) => event.kind)).toEqual([
      'connected',
      'pair_ok',
    ]);
    ws.close();
  });

  it('never puts the pairing code into the state', async () => {
    const h = await harness();
    const opened = (await h.command({ name: 'remoteAccess.pair' })) as {
      code: string;
      expiresAt: string;
      port: number;
    };
    expect(opened.port).toBe(h.port());
    const state = JSON.stringify(h.service.state());
    expect(state).not.toContain(opened.code);
    expect(state).not.toContain(opened.code.replaceAll('-', ''));
    expect(h.service.state()?.pairingExpiresAt).toBe(opened.expiresAt);
    await h.command({ name: 'remoteAccess.cancelPairing' });
    expect(h.service.state()?.pairingExpiresAt).toBeNull();
  });

  it('commands outside the share role → REMOTE_ROLE_CONFLICT with the current role', async () => {
    const h = await harness({ activate: false, currentRole: () => 'control' });
    expect(h.service.state()).toBeNull();
    const error = await commandError(h.command({ name: 'remoteAccess.pair' }));
    expect(error.error).toEqual({ code: 'REMOTE_ROLE_CONFLICT', params: { role: 'control' } });
  });

  it('activation without key store → REMOTE_KEYSTORE_UNAVAILABLE, not listening, shown in the state', async () => {
    const keyStore = createMemoryKeyStore({ available: false });
    const h = await harness({ activate: false, keyStore });
    const error = await commandError(h.service.activate(SHARE_CONFIG));
    expect(error.error.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
    expect(h.service.state()).toMatchObject({
      listening: false,
      error: { code: 'REMOTE_KEYSTORE_UNAVAILABLE' },
    });
    expect(h.service.state()?.checks.find((check) => check.id === 'keystore')?.status).toBe('error');
    // A later check with a working key store starts the listener.
    keyStore.setAvailable(true);
    await h.command({ name: 'remoteAccess.check' });
    expect(h.service.state()).toMatchObject({ listening: true, error: null });
  });

  it('a port in use → REMOTE_ACCESS_FAILED port_in_use', async () => {
    const first = await harness();
    const second = await harness({ activate: false, probePort: () => Promise.resolve('ok') });
    const error = await commandError(second.service.activate({ ...SHARE_CONFIG, port: first.port() }));
    expect(error.error).toEqual({ code: 'REMOTE_ACCESS_FAILED', params: { reason: 'port_in_use' } });
  });

  it('deactivate closes the port and every connection but keeps the coupling; activate again works', async () => {
    const h = await harness();
    const paired = await h.pair();
    const agent = h.agent(paired);
    const ws = openWebSocket(agent, h.port());
    await new Promise((resolve) => ws.once('open', resolve));
    const port = h.port();
    const wsClosed = closed(ws);
    await h.service.deactivate();
    expect(h.service.state()).toBeNull();
    expect(await wsClosed).toBeGreaterThan(0);
    expect(h.hub.closed).toContain(WS_CLOSE.SERVER_SHUTDOWN);
    await expect(agentRequest(agent, port, REMOTE_PATHS.health)).rejects.toBeInstanceOf(
      PinnedConnectionError,
    );
    expect(h.service.couplings()).toBe(1);
    await h.service.activate(SHARE_CONFIG);
    const again = await agentRequest(h.agent(paired), h.port(), REMOTE_PATHS.health);
    expect(again.status).toBe(200);
  });

  it('the coupling survives a restart (kAuth from the key store)', async () => {
    const keyStore = createMemoryKeyStore();
    const first = await harness({ keyStore });
    const paired = await first.pair();
    const file = JSON.parse(await readFile(path.join(first.home, REMOTE_DIR, PEER_FILE), 'utf8')) as {
      peer: { authKey: string };
    };
    expect(Buffer.from(file.peer.authKey, 'base64').includes(paired.authKey)).toBe(false);
    await first.close();
    harnesses.splice(harnesses.indexOf(first), 1);
    const second = await harness({ keyStore, home: first.home });
    const answer = await agentRequest(second.agent(paired), second.port(), REMOTE_PATHS.health);
    expect(answer.status).toBe(200);
  });

  it('version mismatch → 409 HOST_INCOMPATIBLE, logged, peer shown as incompatible', async () => {
    const h = await harness();
    const paired = await h.pair();
    const agent = h.agent(paired);
    const answer = await agentRequest(agent, h.port(), REMOTE_PATHS.health, {
      headers: { 'parallax-version': '9.9.9' },
    });
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toEqual({
      code: 'HOST_INCOMPATIBLE',
      params: { version: TEST_VERSION, protocol: PROTOCOL_VERSION },
    });
    expect(h.service.state()?.peer).toMatchObject({ appVersion: '9.9.9', compatible: false });
    const ws = openWebSocket(agent, h.port(), { 'parallax-version': TEST_VERSION, 'parallax-protocol': '4' });
    const failure = await new Promise<string>((resolve) =>
      ws.once('unexpected-response', (_req, res) => {
        resolve(String(res.statusCode));
      }),
    );
    expect(failure).toBe('409');
    expect(h.hub.sockets).toHaveLength(0);
    expect(h.service.state()?.unseenRejected).toBeGreaterThan(0);
  });

  it('browser headers (Origin, Sec-Fetch-Site, Cookie) → 403 and close, on HTTP and WebSocket', async () => {
    const h = await harness();
    const paired = await h.pair();
    const browserHeaders: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { cookie: 'a=b' },
    ];
    for (const headers of browserHeaders) {
      const answer = await agentRequest(h.agent(paired), h.port(), '/remote/v1/blob/b1', { headers });
      expect(answer.status).toBe(403);
      expect(JSON.parse(answer.body)).toMatchObject({ code: 'ORIGIN_REJECTED' });
    }
    const ws = openWebSocket(h.agent(paired), h.port(), {
      ...remoteVersionHeaders(TEST_VERSION),
      origin: 'https://evil.example',
    });
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
      }),
    );
    expect(status).toBe(403);
    expect(h.blobHits).toEqual([]);
    expect(h.hub.sockets).toHaveLength(0);
    const events = (await h.command({ name: 'remoteAccess.events', onlyRejected: true })) as {
      events: { kind: string; count: number }[];
    };
    expect(events.events[0]).toMatchObject({ kind: 'browser_rejected' });
  });

  it('only the allowlisted routes exist (404 for others); content routes outside the allowlist are refused', async () => {
    const h = await harness();
    const paired = await h.pair();
    const agent = h.agent(paired);
    expect((await agentRequest(agent, h.port(), '/api/health')).status).toBe(404);
    expect((await agentRequest(agent, h.port(), REMOTE_PATHS.pair, { method: 'POST' })).status).toBe(404);
    expect((await agentRequest(agent, h.port(), '/remote/v1/blob/b2')).status).toBe(200);
    expect(h.blobHits).toEqual(['b2']);
    const bad = startHarness({
      registerContent: (app) => {
        app.get('/remote/v1/anything', () => ({}));
      },
    });
    await expect(bad).rejects.toThrow(/not allowed/u);
  });

  it('marks the log seen (eventsSeen) and filters rejected events', async () => {
    const h = await harness();
    await h.command({ name: 'remoteAccess.pair' });
    const paired = await h.pair();
    await agentRequest(h.agent(paired), h.port(), REMOTE_PATHS.health, { headers: { cookie: 'x=y' } });
    expect(h.service.state()?.unseenRejected).toBe(1);
    await h.command({ name: 'remoteAccess.eventsSeen' });
    expect(h.service.state()?.unseenRejected).toBe(0);
    const all = (await h.command({ name: 'remoteAccess.events', onlyRejected: false })) as {
      events: { kind: string }[];
    };
    const rejected = (await h.command({ name: 'remoteAccess.events', onlyRejected: true })) as {
      events: { kind: string }[];
    };
    expect(all.events.length).toBeGreaterThan(rejected.events.length);
    expect(rejected.events.map((event) => event.kind)).toEqual(['browser_rejected']);
  });

  it('notifies on state changes only when the state changed', async () => {
    const h = await harness();
    let calls = 0;
    h.service.onChange(() => (calls += 1));
    await h.command({ name: 'remoteAccess.pair' });
    const afterPair = calls;
    expect(afterPair).toBeGreaterThan(0);
    await h.command({ name: 'remoteAccess.events', onlyRejected: false });
    expect(calls).toBe(afterPair);
  });

  it('a peer write failure during pairing → REMOTE_ACCESS_FAILED, nothing stored', async () => {
    const control = { fail: false };
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: (file, data) =>
        control.fail ? Promise.reject(new Error('disk')) : nodeFsOps.writeFile(file, data),
    };
    const h0 = await harness({ activate: false });
    const peerStore = createPeerStore({ home: h0.home, fs, retryDelaysMs: [] });
    const h = await harness({ home: h0.home, peerStore });
    control.fail = true;
    await expect(h.pair()).rejects.toMatchObject({
      error: { code: 'REMOTE_ACCESS_FAILED', params: { reason: 'store' } },
    });
    expect(h.service.state()?.peer).toBeNull();
    expect(h.service.couplings()).toBe(0);
  });
});
