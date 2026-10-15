import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  authCookieName,
  authStatusResponseSchema,
  bearerAuthorization,
  launcherCodeResponseSchema,
} from '@shared/http';
import type { TranscriptItem } from '@shared/model';
import { PROTOCOL_VERSION, WS_CLOSE, type SessionOp } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleClientHello,
  sampleDetail,
  sampleItems,
  sampleSummary,
  sampleUuid,
} from '@shared/samples';
import type { SessionViewState } from '@shared/sync';
import {
  connectAndHello,
  connectWs,
  cookieFromSetCookie,
  rawRequest,
  startTestServer,
  type TestServer,
} from '../http/testServer';

const ENTRY = SAMPLE_IDS.entry;

function textItem(order: number): TranscriptItem {
  return sampleItems.assistantText({ id: `msg_${String(order)}:0`, order, text: `item ${String(order)}` });
}

function viewWith(items: TranscriptItem[]): SessionViewState {
  return {
    entryId: ENTRY,
    seq: 999, // ignored by the hub (R0-20)
    conversationId: SAMPLE_IDS.conversation,
    items,
    hasEarlier: false,
    decisions: [],
    detail: sampleDetail(),
  };
}

const upsert = (order: number): SessionOp => ({ op: 'item.upsert', item: textItem(order) });

let server: TestServer | null = null;

// The first server of a worker pays a one-time warm-up (~2 s idle, >10 s under parallel load,
// docs/wp/FLAKES.md). It is paid here with a generous hook limit, so no single test carries it.
beforeAll(async () => {
  const warm = await startTestServer();
  const ws = await connectAndHello(warm, await warm.login(), sampleClientHello());
  await ws.close();
  await warm.close();
}, 60_000);

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(options: Parameters<typeof startTestServer>[0] = {}): Promise<TestServer> {
  server = await startTestServer(options);
  return server;
}

describe('auth flow (code → cookie → WS)', () => {
  it('exchanges a code for the device cookie and completes the handshake', async () => {
    const s = await start();
    s.source.addEntry({ entryId: ENTRY, summary: sampleSummary() });

    const before = await rawRequest(s.port, { method: 'GET', path: '/api/auth/status' });
    expect(before.status).toBe(200);
    expect(authStatusResponseSchema.parse(JSON.parse(before.body))).toEqual({
      authenticated: false,
      serverInstanceId: s.instance.serverInstanceId,
    });

    const { code } = s.auth.issueAuthCode();
    const exchange = await rawRequest(s.port, {
      method: 'POST',
      path: '/api/auth',
      headers: { origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(exchange.status).toBe(200);
    expect(JSON.parse(exchange.body)).toEqual({
      authenticated: true,
      serverInstanceId: s.instance.serverInstanceId,
    });
    const setCookie = String(exchange.headers['set-cookie']);
    expect(setCookie).toContain(`${authCookieName(s.port)}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=34560000');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).not.toContain('Domain');
    const cookie = cookieFromSetCookie(exchange.headers['set-cookie'], authCookieName(s.port)) ?? '';

    const after = await rawRequest(s.port, { method: 'GET', path: '/api/auth/status', headers: { cookie } });
    expect(JSON.parse(after.body)).toMatchObject({ authenticated: true });

    // The code is single use.
    const again = await rawRequest(s.port, {
      method: 'POST',
      path: '/api/auth',
      headers: { origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(again.status).toBe(401);
    expect(JSON.parse(again.body)).toMatchObject({ code: 'AUTH_CODE_INVALID' });

    const result = await connectWs(s, { cookie });
    if (!result.ok) throw new Error('rejected');
    const ws = result.client;
    const hello = await ws.next('hello');
    expect(hello).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      buildId: 'dev',
      serverInstanceId: s.instance.serverInstanceId,
      serverVersion: '0.0.0-test',
      serverStartedAt: s.instance.startedAt,
    });
    ws.send(sampleClientHello());
    const host = await ws.next('host.state');
    expect(host.host).toEqual(s.source.host);
    const snapshot = await ws.next('summaries.snapshot');
    expect(snapshot.summaries).toEqual([sampleSummary()]);
    // Order: hello, host.state, summaries.snapshot.
    expect(ws.messages.map((m) => m.type)).toEqual(['hello', 'host.state', 'summaries.snapshot']);
    expect(s.source.presenceUpdates.at(-1)).toHaveLength(1);
    await ws.close();
  });

  it('rejects an expired code', async () => {
    const s = await start();
    const { code } = s.auth.issueAuthCode(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const res = await rawRequest(s.port, {
      method: 'POST',
      path: '/api/auth',
      headers: { origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });
});

describe('WS upgrade guard', () => {
  it.each([
    ['without cookie', { cookie: undefined }, 401, 'AUTH_REQUIRED', undefined],
    ['with a foreign origin', { origin: 'http://evil.example' }, 403, 'ORIGIN_REJECTED', 'origin'],
    ['with Origin: null', { origin: 'null' }, 403, 'ORIGIN_REJECTED', 'origin-null'],
    ['without Origin', { origin: null }, 403, 'ORIGIN_REJECTED', 'origin'],
    ['from another local port', { origin: 'http://127.0.0.1:1' }, 403, 'ORIGIN_REJECTED', 'origin'],
    ['with Sec-Fetch-Site cross-site', { site: 'cross-site' }, 403, 'ORIGIN_REJECTED', 'sec-fetch-site'],
    ['with Sec-Fetch-Site same-site', { site: 'same-site' }, 403, 'ORIGIN_REJECTED', 'sec-fetch-site'],
    ['with Sec-Fetch-Site none', { site: 'none' }, 403, 'ORIGIN_REJECTED', 'sec-fetch-site'],
    ['with a wrong Host', { host: 'localhost' }, 403, 'HOST_HEADER_REJECTED', undefined],
  ] as const)('rejects the upgrade %s', async (_name, overrides, status, code, reason) => {
    const s = await start();
    const cookie = await s.login();
    const result = await connectWs(s, { cookie, ...overrides });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(status);
    const body: unknown = JSON.parse(result.body);
    expect(body).toMatchObject({ code });
    if (reason !== undefined) expect(body).toMatchObject({ params: { reason } });
  });

  // V1-01: Chrome/Edge send no Sec-Fetch-Site on the WebSocket handshake (connectWs sends none by default).
  it.each([
    ['without Sec-Fetch-Site (like Chrome/Edge)', undefined],
    ['with Sec-Fetch-Site same-origin', 'same-origin'],
  ] as const)('accepts the upgrade %s', async (_name, site) => {
    const s = await start();
    const result = await connectWs(s, { cookie: await s.login(), site });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.client.next('hello')).toMatchObject({
      serverInstanceId: s.instance.serverInstanceId,
    });
    await result.client.close();
  });

  it('still rejects a foreign Origin without Sec-Fetch-Site, even with a valid cookie', async () => {
    const s = await start();
    const result = await connectWs(s, { cookie: await s.login(), origin: 'http://evil.example' });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a cookie of another port', async () => {
    const s = await start();
    const cookie = (await s.login()).replace(authCookieName(s.port), authCookieName(s.port === 1 ? 2 : 1));
    const result = await connectWs(s, { cookie });
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});

describe('HTTP guard for non-GET requests', () => {
  const post = (s: TestServer, headers: Record<string, string>) =>
    rawRequest(s.port, {
      method: 'POST',
      path: '/api/auth',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ code: s.auth.issueAuthCode().code }),
    });

  it('accepts same-origin', async () => {
    const s = await start();
    expect((await post(s, { origin: s.origin, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it.each([
    ['foreign origin', { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }, 'ORIGIN_REJECTED'],
    ['Origin: null', { origin: 'null', 'sec-fetch-site': 'same-origin' }, 'ORIGIN_REJECTED'],
    ['missing Sec-Fetch-Site', { origin: 'ORIGIN' }, 'ORIGIN_REJECTED'],
    [
      'Sec-Fetch-Site none (typed URL / bookmark)',
      { origin: 'ORIGIN', 'sec-fetch-site': 'none' },
      'ORIGIN_REJECTED',
    ],
    ['missing Origin', { 'sec-fetch-site': 'same-origin' }, 'ORIGIN_REJECTED'],
    [
      'wrong Host',
      { origin: 'ORIGIN', 'sec-fetch-site': 'same-origin', host: 'evil.example' },
      'HOST_HEADER_REJECTED',
    ],
  ] as const)('rejects %s', async (_name, headers, code) => {
    const s = await start();
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, v === 'ORIGIN' ? s.origin : v]),
    );
    const res = await post(s, resolved);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ code });
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });

  it('requires the cookie for other mutations', async () => {
    const s = await start();
    const res = await rawRequest(s.port, {
      method: 'POST',
      path: '/api/attachments',
      headers: { origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'image/png' },
      body: 'x',
    });
    expect(res.status).toBe(401);
    const cookie = await s.login();
    const ok = await rawRequest(s.port, {
      method: 'POST',
      path: '/api/attachments',
      headers: { origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'image/png', cookie },
      body: 'x',
    });
    expect(ok.status).toBe(501);
    expect(JSON.parse(ok.body)).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });
});

describe('launcher code (POST /api/launcher/code)', () => {
  const launcherCode = (s: TestServer, headers: Record<string, string>) =>
    rawRequest(s.port, { method: 'POST', path: '/api/launcher/code', headers });

  it('issues a single-use code for the launcher token', async () => {
    const s = await start();
    const res = await launcherCode(s, { authorization: bearerAuthorization(s.auth.launcherToken) });
    expect(res.status).toBe(200);
    const issued = launcherCodeResponseSchema.parse(JSON.parse(res.body));
    expect(issued.serverInstanceId).toBe(s.instance.serverInstanceId);
    const exchange = (code: string) =>
      rawRequest(s.port, {
        method: 'POST',
        path: '/api/auth',
        headers: { origin: s.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
    expect((await exchange(issued.code)).status).toBe(200);
    // used twice → rejected
    const second = await exchange(issued.code);
    expect(second.status).toBe(401);
    expect(JSON.parse(second.body)).toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });

  it('rejects an invalid token, an Origin and Sec-Fetch-Site other than none', async () => {
    const s = await start();
    const bad = await launcherCode(s, { authorization: bearerAuthorization('x'.repeat(43)) });
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.body)).toMatchObject({ code: 'LAUNCHER_TOKEN_INVALID' });
    expect((await launcherCode(s, {})).status).toBe(401);

    const withOrigin = await launcherCode(s, {
      authorization: bearerAuthorization(s.auth.launcherToken),
      origin: s.origin,
    });
    expect(withOrigin.status).toBe(403);
    expect(JSON.parse(withOrigin.body)).toMatchObject({ code: 'ORIGIN_REJECTED' });

    const viaBrowser = await launcherCode(s, {
      authorization: bearerAuthorization(s.auth.launcherToken),
      'sec-fetch-site': 'same-origin',
    });
    expect(viaBrowser.status).toBe(403);

    const none = await launcherCode(s, {
      authorization: bearerAuthorization(s.auth.launcherToken),
      'sec-fetch-site': 'none',
    });
    expect(none.status).toBe(200);
  });
});

describe('subscriptions over the wire', () => {
  it('snapshot, live ops, replay after reconnect, snapshot outside the buffer, loadEarlier', async () => {
    const s = await start();
    const history = [1, 2, 3, 4, 5].map(textItem);
    s.source.addEntry({
      entryId: ENTRY,
      summary: sampleSummary(),
      view: viewWith(history.slice(2)),
      history,
    });
    const cookie = await s.login();

    const ws = await connectAndHello(s, cookie, sampleClientHello());
    ws.send({ type: 'subscribe', entryId: ENTRY });
    const snapshot = await ws.next('session.snapshot');
    expect(snapshot).toMatchObject({ entryId: ENTRY, seq: 0, hasEarlier: false });
    expect(snapshot.items.map((i) => i.order)).toEqual([3, 4, 5]);
    expect(s.source.subscriberCounts.at(-1)).toEqual({ entryId: ENTRY, count: 1 });

    s.hub.publishOps(ENTRY, [upsert(6), upsert(7)]);
    const live = await ws.next('session.ops');
    expect(live.ops.map((o) => o.seq)).toEqual([1, 2]);

    // loadEarlier is a command answered by the source (engine: TranscriptStore.readBefore).
    const cmdId = sampleUuid(300);
    ws.send({
      type: 'cmd',
      cmdId,
      cmd: {
        name: 'transcript.loadEarlier',
        entryId: ENTRY,
        conversationId: SAMPLE_IDS.conversation,
        beforeOrder: 3,
        limit: 1,
      },
    });
    const ack = await ws.next('ack', (a) => a.cmdId === cmdId);
    expect(ack).toMatchObject({ ok: true, result: { hasEarlier: true } });
    expect(ack.ok && ack.result).toMatchObject({ items: [{ order: 2 }] });

    await ws.close();
    s.hub.publishOps(ENTRY, [upsert(8)]);

    const again = await connectAndHello(s, cookie, sampleClientHello());
    again.send({ type: 'subscribe', entryId: ENTRY, sinceSeq: 2 });
    const replay = await again.next('session.ops');
    expect(replay.ops.map((o) => o.seq)).toEqual([3]);
    expect(replay.ops[0]?.op).toEqual(upsert(8));

    // Already up to date → empty replay.
    again.send({ type: 'subscribe', entryId: ENTRY, sinceSeq: 3 });
    expect((await again.next('session.ops')).ops).toEqual([]);

    // A seq from another instance (larger than the current one) → snapshot.
    again.send({ type: 'subscribe', entryId: ENTRY, sinceSeq: 50 });
    const resync = await again.next('session.snapshot');
    expect(resync.seq).toBe(3);
    expect(resync.items.map((i) => i.order)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(again.invalid).toEqual([]);
    await again.close();
  });

  it('answers session.unavailable for unknown entries', async () => {
    const s = await start();
    const ws = await connectAndHello(s, await s.login(), sampleClientHello());
    ws.send({ type: 'subscribe', entryId: SAMPLE_IDS.entry });
    expect(await ws.next('session.unavailable')).toMatchObject({ error: { code: 'ENTRY_NOT_FOUND' } });
    await ws.close();
  });
});

describe('command idempotency over the wire', () => {
  it('answers a resent cmdId from the cache without running the command again', async () => {
    const s = await start();
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.source.setHandler('session.sendPrompt', async () => {
      calls += 1;
      await gate;
      return { messageUuid: sampleUuid(7) };
    });
    const cookie = await s.login();
    const ws = await connectAndHello(s, cookie, sampleClientHello());
    const cmd = {
      type: 'cmd',
      cmdId: sampleUuid(400),
      cmd: { name: 'session.sendPrompt', entryId: ENTRY, prompt: { text: 'hi' } },
    };
    ws.send(cmd);
    ws.send(cmd); // duplicate while running: waits for the same result
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const first = await ws.next('ack');
    const second = await ws.next('ack');
    expect(first).toEqual({
      type: 'ack',
      cmdId: sampleUuid(400),
      ok: true,
      result: { messageUuid: sampleUuid(7) },
    });
    expect(second).toEqual(first);
    await ws.close();

    // Reconnect (same instance): the unconfirmed command is resent with the same cmdId.
    const again = await connectAndHello(s, cookie, sampleClientHello());
    again.send(cmd);
    expect(await again.next('ack')).toEqual(first);
    expect(calls).toBe(1);
    await again.close();
  });

  it('acks schema violations with VALIDATION_FAILED and answers bad JSON with an error', async () => {
    const s = await start();
    const ws = await connectAndHello(s, await s.login(), sampleClientHello());
    ws.send({ type: 'cmd', cmdId: sampleUuid(401), cmd: { name: 'session.interrupt', entryId: 'nope' } });
    expect(await ws.next('ack')).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', params: { path: 'cmd.entryId' } },
    });
    ws.sendRaw('{not json');
    expect(await ws.next('error')).toMatchObject({ error: { code: 'INVALID_MESSAGE' }, inReplyTo: null });
    await ws.close();
  });
});

describe('closing', () => {
  it('closes open sockets with 4401 when the secret is rotated, the old cookie stops working', async () => {
    const s = await start();
    const cookie = await s.login();
    const ws = await connectAndHello(s, cookie, sampleClientHello());
    await s.auth.rotateSecret();
    expect((await ws.closed).code).toBe(WS_CLOSE.AUTH_REVOKED);
    expect(await connectWs(s, { cookie })).toMatchObject({ ok: false, status: 401 });
  });

  it('closes open sockets with 4503 on shutdown', async () => {
    const s = await start();
    const ws = await connectAndHello(s, await s.login(), sampleClientHello());
    await s.close();
    server = null;
    expect((await ws.closed).code).toBe(WS_CLOSE.SERVER_SHUTDOWN);
  });

  it('closes with 4400 when the first message is not clientHello', async () => {
    const s = await start();
    const result = await connectWs(s, { cookie: await s.login() });
    if (!result.ok) throw new Error('rejected');
    await result.client.next('hello');
    result.client.send({ type: 'subscribe', entryId: ENTRY });
    expect(await result.client.next('error')).toMatchObject({
      error: { code: 'INVALID_MESSAGE' },
      inReplyTo: 'subscribe',
    });
    expect((await result.client.closed).code).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });
});

describe('dev mode', () => {
  it('accepts the Vite origin and host', async () => {
    const s = await start({ dev: true });
    const cookie = await s.login();
    const result = await connectWs(s, { cookie, origin: 'http://127.0.0.1:5173', host: '127.0.0.1:5173' });
    expect(result.ok).toBe(true);
    if (result.ok) await result.client.close();
  });
});
