import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { REMOTE_PATHS } from '@shared/http';
import { WS_CLOSE } from '@shared/protocol';
import { nodeFsOps, type FsOps } from '../lib/fs';
import { PinnedConnectionError, REMOTE_WS_CLIENT_OPTIONS, remoteVersionHeaders } from '../secure/pinnedAgent';
import { TEST_HOST } from '../secure/testKit';
import { CommandError } from '../sync/ports';
import { createPeerStore } from './peerStore';
import { TEST_VERSION, agentRequest, startHarness, type Harness } from './testKit';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const started = await startHarness(options);
  harnesses.push(started);
  return started;
}

async function rejectedKinds(h: Harness): Promise<string[]> {
  const result = (await h.command({ name: 'remoteAccess.events', onlyRejected: false })) as {
    events: { kind: string }[];
  };
  return result.events.map((event) => event.kind);
}

function openWebSocket(h: Harness, agent: ReturnType<Harness['agent']>): Promise<WebSocket> {
  const ws = new WebSocket(`wss://${TEST_HOST}:${String(h.port())}${REMOTE_PATHS.ws}`, {
    agent,
    ...REMOTE_WS_CLIENT_OPTIONS,
    headers: remoteVersionHeaders(TEST_VERSION),
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function closedCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve(1006);
    else
      ws.once('close', (code: number) => {
        resolve(code);
      });
  });
}

describe('unpair, replace, renew (§B.8)', () => {
  it('unpair cuts a running WebSocket and an HTTP request at once; a late handler has no effect', async () => {
    const entered = deferred();
    const released = deferred();
    const effects: string[] = [];
    const h = await harness({
      registerContent: (app, context) => {
        app.get(REMOTE_PATHS.blob, async (req, reply) => {
          entered.resolve();
          await released.promise;
          if (!context.isCurrent(req)) {
            reply.hijack();
            req.raw.socket.destroy();
            return reply;
          }
          effects.push('served');
          return {};
        });
      },
    });
    const paired = await h.pair();
    const agent = h.agent(paired);
    const ws = await openWebSocket(h, agent);
    const wsClosed = closedCode(ws);
    const pending = agentRequest(h.agent(paired), h.port(), '/remote/v1/blob/slow').then(
      () => 'answered',
      () => 'cut',
    );
    await entered.promise;
    const hubSocket = h.hub.sockets[0]?.socket;
    expect(hubSocket === undefined ? false : h.service.isCurrentConnection(hubSocket)).toBe(true);

    await h.command({ name: 'remoteAccess.unpair' });
    expect(h.service.state()?.peer).toBeNull();
    expect(h.hub.closed).toEqual([WS_CLOSE.HOST_REVOKED]);
    expect(await wsClosed).toBeGreaterThan(0);
    expect(await pending).toBe('cut');
    expect(hubSocket === undefined ? true : h.service.isCurrentConnection(hubSocket)).toBe(false);
    released.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(effects).toEqual([]);

    // A new connection with the revoked key is refused after TLS and logged as revoked.
    const error = await agentRequest(h.agent(paired), h.port(), REMOTE_PATHS.health).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PinnedConnectionError);
    expect(await rejectedKinds(h)).toEqual(expect.arrayContaining(['revoked_key', 'unpaired']));
  });

  it('a failed write on unpair stops the listener (REMOTE_ACCESS_FAILED store) until a write succeeds', async () => {
    const control = { fail: false };
    const fs: FsOps = {
      ...nodeFsOps,
      writeFile: (file, data) =>
        control.fail ? Promise.reject(new Error('disk')) : nodeFsOps.writeFile(file, data),
    };
    const base = await harness({ activate: false });
    const h = await harness({
      home: base.home,
      peerStore: createPeerStore({ home: base.home, fs, retryDelaysMs: [] }),
    });
    await h.pair();
    control.fail = true;
    const error = await h.command({ name: 'remoteAccess.unpair' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).error).toEqual({
      code: 'REMOTE_ACCESS_FAILED',
      params: { reason: 'store' },
    });
    expect(h.service.state()).toMatchObject({
      listening: false,
      peer: null,
      error: { code: 'REMOTE_ACCESS_FAILED' },
    });
    control.fail = false;
    await h.command({ name: 'remoteAccess.check' });
    expect(h.service.state()).toMatchObject({ listening: true, error: null });
  });

  it('DELETE peer/self: the controlling computer drops the coupling itself', async () => {
    const h = await harness();
    const paired = await h.pair();
    const agent = h.agent(paired);
    const ws = await openWebSocket(h, h.agent(paired));
    const wsClosed = closedCode(ws);
    const answer = await agentRequest(agent, h.port(), REMOTE_PATHS.peerSelf, { method: 'DELETE' });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({});
    expect(h.service.state()?.peer).toBeNull();
    expect(await wsClosed).toBeGreaterThan(0);
    expect(h.service.couplings()).toBe(0);
    await expect(agentRequest(h.agent(paired), h.port(), REMOTE_PATHS.health)).rejects.toBeInstanceOf(
      PinnedConnectionError,
    );
  });

  it('pairing again replaces the coupling: the old one is cut and revoked', async () => {
    const h = await harness();
    const old = await h.pair();
    const ws = await openWebSocket(h, h.agent(old));
    const wsClosed = closedCode(ws);
    const fresh = await h.pair();
    expect(await wsClosed).toBeGreaterThan(0);
    expect((await agentRequest(h.agent(fresh), h.port(), REMOTE_PATHS.health)).status).toBe(200);
    await expect(agentRequest(h.agent(old), h.port(), REMOTE_PATHS.health)).rejects.toBeInstanceOf(
      PinnedConnectionError,
    );
    expect(await rejectedKinds(h)).toContain('revoked_key');
  });

  it('renewKey: new identity, coupling revoked, the old pin no longer matches', async () => {
    const h = await harness();
    const paired = await h.pair();
    await h.command({ name: 'remoteAccess.renewKey' });
    expect(h.service.state()?.peer).toBeNull();
    const error = await agentRequest(h.agent(paired), h.port(), REMOTE_PATHS.health).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PinnedConnectionError);
    expect(['tls', 'pin', 'network']).toContain((error as PinnedConnectionError).reason);
    const again = await h.pair();
    expect(again.peerPin).not.toBe(paired.peerPin);
    expect((await agentRequest(h.agent(again), h.port(), REMOTE_PATHS.health)).status).toBe(200);
  });
});
