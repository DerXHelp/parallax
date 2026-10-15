import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { SeqOp, SessionOp } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleHello,
  sampleHostState,
  sampleItems,
  sampleSessionSnapshot,
  sampleSummary,
  sampleTime,
  sampleUuid,
} from '@shared/samples';
import { applySeqOps, viewStateFromSnapshot } from '@shared/sync';
import type { AuthCheckResult } from './auth';
import { ClientCommandError, createHostConnection, type HostConnectionOptions } from './connection';
import { createClientStore } from './store';
import { createMemoryTransport } from './transport';

const ENTRY = SAMPLE_IDS.entry;
const KEY = makeSessionKey('local', ENTRY);

function setup(options: Partial<HostConnectionOptions> = {}) {
  const store = createClientStore();
  const transport = createMemoryTransport();
  const reload = vi.fn();
  let reloadAt: number | null = null;
  const frames: (() => void)[] = [];
  const connection = createHostConnection({
    hostId: 'local',
    store,
    createTransport: () => transport,
    reload,
    reloadGuard: {
      read: () => reloadAt,
      write: (at) => {
        reloadAt = at;
      },
    },
    clientId: SAMPLE_IDS.client,
    buildId: 'dev',
    random: () => 0.5,
    scheduleFrame: (callback) => {
      frames.push(callback);
    },
    ...options,
  });
  const flushFrames = () => {
    for (let frame = frames.shift(); frame !== undefined; frame = frames.shift()) frame();
  };
  const host = () => store.getState().hosts.local;
  const session = () => store.getState().sessions[KEY];
  return { store, transport, connection, reload, flushFrames, host, session, frames };
}

function seqOps(from: number, ops: readonly SessionOp[]): SeqOp[] {
  return ops.map((op, index) => ({ seq: from + index, at: sampleTime(from + index), op }));
}

const streamingText = sampleItems.assistantText({ id: 'msg_live:0', order: 6, text: 'Hel', streaming: true });

describe('handshake', () => {
  it('answers hello with clientHello (build id, client id, presence) and becomes open', () => {
    const { transport, connection, host } = setup();
    connection.start();
    expect(transport.connected).toBe(true);
    expect(connection.status()).toBe('connecting');
    transport.serverSend(sampleHello());
    const [hello] = transport.sentOfType('clientHello');
    expect(hello).toMatchObject({ protocolVersion: 1, buildId: 'dev', clientId: SAMPLE_IDS.client });
    expect(hello?.presence).toMatchObject({
      focused: true,
      visible: true,
      viewingEntryId: null,
      typing: false,
    });
    expect(connection.status()).toBe('open');
    expect(host()?.phase).toBe('open');
    expect(host()?.serverInstanceId).toBe(SAMPLE_IDS.serverInstanceId);
  });

  it('ignores everything before hello and counts unknown or invalid messages', () => {
    const { transport, connection, host } = setup();
    connection.start();
    transport.serverSend({ type: 'host.state', host: sampleHostState() });
    expect(host()?.hostState).toBeNull();
    transport.serverSend(sampleHello());
    transport.serverSendRaw(JSON.stringify({ type: 'brand.new', x: 1 }));
    transport.serverSendRaw('{not json');
    expect(host()?.counters).toMatchObject({ ignoredMessages: 2, invalidMessages: 1 });
  });

  it('applies host.state and summaries (snapshot, upsert, remove)', () => {
    const { transport, connection, host } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    transport.serverSend({ type: 'host.state', host: sampleHostState() });
    transport.serverSend({ type: 'summaries.snapshot', summaries: [sampleSummary()] });
    expect(host()?.summaries[ENTRY]?.title).toBe('Sample session');
    expect(host()?.summariesLoaded).toBe(true);
    transport.serverSend({ type: 'summary.upsert', summary: sampleSummary({ title: 'Renamed' }) });
    expect(host()?.summaries[ENTRY]?.title).toBe('Renamed');
    transport.serverSend({ type: 'summary.remove', entryId: ENTRY });
    expect(host()?.summaries[ENTRY]).toBeUndefined();
    expect(host()?.hostState?.backend).toBe('fake');
  });
});

describe('subscriptions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are ref-counted and unsubscribe after the delay', () => {
    const { transport, connection } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    const releaseA = connection.subscribe(ENTRY);
    const releaseB = connection.subscribe(ENTRY);
    expect(transport.sentOfType('subscribe')).toEqual([{ type: 'subscribe', entryId: ENTRY }]);
    releaseA();
    releaseA();
    vi.advanceTimersByTime(5000);
    expect(transport.sentOfType('unsubscribe')).toHaveLength(0);
    releaseB();
    vi.advanceTimersByTime(1000);
    // Re-subscribing within the delay keeps the server subscription.
    const releaseC = connection.subscribe(ENTRY);
    vi.advanceTimersByTime(5000);
    expect(transport.sentOfType('unsubscribe')).toHaveLength(0);
    expect(transport.sentOfType('subscribe')).toHaveLength(1);
    releaseC();
    vi.advanceTimersByTime(1500);
    expect(transport.sentOfType('unsubscribe')).toEqual([{ type: 'unsubscribe', entryId: ENTRY }]);
  });

  it('subscribes when the connection opens and re-subscribes with sinceSeq on a cached view', () => {
    const { transport, connection, session } = setup();
    const release = connection.subscribe(ENTRY);
    connection.start();
    transport.serverSend(sampleHello());
    expect(transport.sentOfType('subscribe')).toEqual([{ type: 'subscribe', entryId: ENTRY }]);
    expect(session()?.loading).toBe(true);
    transport.serverSend(sampleSessionSnapshot());
    expect(session()?.loading).toBe(false);
    release();
    vi.advanceTimersByTime(1500);
    // The view stays cached; a new subscription asks for a replay.
    expect(session()?.view?.seq).toBe(5);
    connection.subscribe(ENTRY);
    expect(transport.sentOfType('subscribe').at(-1)).toEqual({
      type: 'subscribe',
      entryId: ENTRY,
      sinceSeq: 5,
    });
  });

  it('evicts views of unsubscribed sessions beyond the cache limit', () => {
    const { transport, connection, store } = setup({ maxCachedViews: 1 });
    connection.start();
    transport.serverSend(sampleHello());
    const other = 'en_00000000000000000000000000000002';
    const releaseA = connection.subscribe(ENTRY);
    const releaseB = connection.subscribe(other);
    transport.serverSend(sampleSessionSnapshot());
    transport.serverSend(sampleSessionSnapshot({ entryId: other }));
    releaseA();
    vi.advanceTimersByTime(1500);
    releaseB();
    vi.advanceTimersByTime(1500);
    expect(store.getState().sessions[KEY]).toBeUndefined();
    expect(store.getState().sessions[makeSessionKey('local', other)]?.view).not.toBeNull();
  });
});

describe('session ops', () => {
  it('apply the shared reducer once per frame (deltas included)', () => {
    const { transport, connection, session, flushFrames, frames } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    connection.subscribe(ENTRY);
    const snapshot = sampleSessionSnapshot();
    transport.serverSend(snapshot);
    expect(session()?.view?.seq).toBe(5);
    expect(session()?.loading).toBe(false);

    const batch1 = seqOps(6, [{ op: 'item.upsert', item: streamingText }]);
    const batch2 = seqOps(7, [
      { op: 'item.delta', itemId: 'msg_live:0', field: 'text', append: 'lo' },
      { op: 'item.delta', itemId: 'msg_live:0', field: 'text', append: ' world' },
    ]);
    transport.serverSend({ type: 'session.ops', entryId: ENTRY, ops: batch1 });
    transport.serverSend({ type: 'session.ops', entryId: ENTRY, ops: batch2 });
    // Not applied before the frame, and only one frame is scheduled.
    expect(session()?.view?.seq).toBe(5);
    expect(frames).toHaveLength(1);
    flushFrames();

    const expected = applySeqOps(applySeqOps(viewStateFromSnapshot(snapshot), batch1).state, batch2).state;
    expect(session()?.view).toEqual(expected);
    const item = session()?.view?.items.find((candidate) => candidate.id === 'msg_live:0');
    expect(item?.kind === 'assistant_text' ? item.text : null).toBe('Hello world');
  });

  it('re-subscribes with sinceSeq on a gap, once, and continues with the replay', () => {
    const { transport, connection, session, flushFrames } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    connection.subscribe(ENTRY);
    transport.serverSend(sampleSessionSnapshot());
    transport.clearSent();

    transport.serverSend({
      type: 'session.ops',
      entryId: ENTRY,
      ops: seqOps(9, [{ op: 'item.upsert', item: streamingText }]),
    });
    flushFrames();
    transport.serverSend({
      type: 'session.ops',
      entryId: ENTRY,
      ops: seqOps(10, [{ op: 'item.remove', itemId: 'x' }]),
    });
    flushFrames();
    expect(transport.sentOfType('subscribe')).toEqual([{ type: 'subscribe', entryId: ENTRY, sinceSeq: 5 }]);
    expect(session()?.view?.seq).toBe(5);

    transport.serverSend({
      type: 'session.ops',
      entryId: ENTRY,
      ops: seqOps(6, [
        { op: 'item.upsert', item: streamingText },
        { op: 'item.delta', itemId: 'msg_live:0', field: 'text', append: '!' },
      ]),
    });
    flushFrames();
    expect(session()?.view?.seq).toBe(7);
    // Caught up: a later gap triggers a new re-subscribe.
    transport.serverSend({
      type: 'session.ops',
      entryId: ENTRY,
      ops: seqOps(12, [{ op: 'item.remove', itemId: 'x' }]),
    });
    flushFrames();
    expect(transport.sentOfType('subscribe').at(-1)).toEqual({
      type: 'subscribe',
      entryId: ENTRY,
      sinceSeq: 7,
    });
  });

  it('drops ops that arrive before the first snapshot and a snapshot supersedes queued ops', () => {
    const { transport, connection, session, flushFrames } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    connection.subscribe(ENTRY);
    transport.serverSend({
      type: 'session.ops',
      entryId: ENTRY,
      ops: seqOps(1, [{ op: 'item.remove', itemId: 'x' }]),
    });
    flushFrames();
    expect(session()?.view).toBeNull();
    transport.serverSend({
      type: 'session.ops',
      entryId: ENTRY,
      ops: seqOps(3, [{ op: 'item.remove', itemId: 'x' }]),
    });
    transport.serverSend(sampleSessionSnapshot());
    flushFrames();
    expect(session()?.view?.seq).toBe(5);
  });

  it('stores session.unavailable', () => {
    const { transport, connection, session } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    connection.subscribe(ENTRY);
    transport.serverSend({
      type: 'session.unavailable',
      entryId: ENTRY,
      error: makeError('ENTRY_NOT_FOUND'),
    });
    expect(session()).toMatchObject({ view: null, loading: false, unavailable: { code: 'ENTRY_NOT_FOUND' } });
  });
});

describe('commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolve with the parsed ack result (cmdId round trip)', async () => {
    const { transport, connection } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    const promise = connection.send({ name: 'session.interrupt', entryId: ENTRY });
    const [cmd] = transport.sentOfType('cmd');
    expect(cmd?.cmd).toEqual({ name: 'session.interrupt', entryId: ENTRY });
    transport.serverSend({
      type: 'ack',
      cmdId: cmd?.cmdId ?? '',
      ok: true,
      result: { stillQueued: [], extra: 1 },
    });
    await expect(promise).resolves.toEqual({ stillQueued: [] });
  });

  it('reject with ClientCommandError (server error, invalid result, timeout, local validation)', async () => {
    const { transport, connection } = setup({ commandTimeoutMs: 1000 });
    connection.start();
    transport.serverSend(sampleHello());

    const failing = connection.send({ name: 'session.close', entryId: ENTRY });
    const failingId = transport.sentOfType('cmd')[0]?.cmdId ?? '';
    transport.serverSend({
      type: 'ack',
      cmdId: failingId,
      ok: false,
      error: makeError('SESSION_NOT_RUNNING'),
    });
    await expect(failing).rejects.toMatchObject({ name: 'ClientCommandError', code: 'SESSION_NOT_RUNNING' });

    const invalid = connection.send({
      name: 'session.sendPrompt',
      entryId: ENTRY,
      prompt: { text: 'hi', attachments: [] },
      priority: 'next',
    });
    const invalidId = transport.sentOfType('cmd')[1]?.cmdId ?? '';
    transport.serverSend({ type: 'ack', cmdId: invalidId, ok: true, result: { messageUuid: 'nope' } });
    await expect(invalid).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });

    const slow = connection.send({ name: 'session.resume', entryId: ENTRY });
    const assertion = expect(slow).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    const sentBefore = transport.sent.length;
    await expect(
      connection.send({ name: 'session.rename', entryId: 'not-an-id', title: 'x' }),
    ).rejects.toBeInstanceOf(ClientCommandError);
    expect(transport.sent.length).toBe(sentBefore);
  });

  it('are resent with the same cmdId after a reconnect to the same instance', async () => {
    const { transport, connection } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    connection.subscribe(ENTRY);
    transport.serverSend(sampleSessionSnapshot());
    const promise = connection.send({ name: 'session.interrupt', entryId: ENTRY });
    const cmdId = transport.sentOfType('cmd')[0]?.cmdId;
    transport.serverClose(1006);
    expect(connection.status()).toBe('reconnecting');
    transport.clearSent();
    await vi.advanceTimersByTimeAsync(500);
    expect(transport.connectCount).toBe(2);
    transport.serverSend(sampleHello());
    expect(transport.sentOfType('subscribe')).toEqual([{ type: 'subscribe', entryId: ENTRY, sinceSeq: 5 }]);
    expect(transport.sentOfType('cmd').map((message) => message.cmdId)).toEqual([cmdId]);
    transport.serverSend({ type: 'ack', cmdId: cmdId ?? '', ok: true, result: { stillQueued: [] } });
    await expect(promise).resolves.toEqual({ stillQueued: [] });
  });

  it('fail when the connection is closed', async () => {
    const { connection } = setup();
    await expect(connection.send({ name: 'server.shutdown' })).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    });
  });
});

describe('resync and reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a new serverInstanceId drops views, summaries and open commands and subscribes without sinceSeq', async () => {
    const { transport, connection, host, session } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    connection.subscribe(ENTRY);
    transport.serverSend({ type: 'summaries.snapshot', summaries: [sampleSummary()] });
    transport.serverSend(sampleSessionSnapshot());
    const pending = connection.send({ name: 'session.interrupt', entryId: ENTRY });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CONNECTION_LOST' });
    transport.serverClose(1006);
    transport.clearSent();
    await vi.advanceTimersByTimeAsync(500);
    transport.serverSend(sampleHello({ serverInstanceId: sampleUuid(999) }));
    await assertion;
    expect(host()?.summaries).toEqual({});
    expect(session()?.view ?? null).toBeNull();
    expect(transport.sentOfType('subscribe')).toEqual([{ type: 'subscribe', entryId: ENTRY }]);
    expect(transport.sentOfType('cmd')).toHaveLength(0);
  });

  it('a new buildId reloads at most once per 30 s, then shows the mismatch', async () => {
    const { transport, connection, reload, host } = setup();
    connection.start();
    transport.serverSend(sampleHello({ buildId: '0.0.1+abc' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(transport.connected).toBe(false);
    expect(host()?.phase).toBe('version-mismatch');

    // Same window again within 30 s (e.g. the reload did not help): no second reload.
    connection.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    transport.serverSend(sampleHello({ buildId: '0.0.1+abc' }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(host()?.error?.code).toBe('PROTOCOL_VERSION_MISMATCH');

    vi.advanceTimersByTime(30_000);
    connection.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    transport.serverSend(sampleHello({ protocolVersion: 2 }));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('reconnects with exponential backoff (capped) and resets it after a handshake', async () => {
    const { transport, connection, host } = setup();
    connection.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      transport.serverClose(1006);
      const next = host()?.nextAttemptAt ?? 0;
      delays.push(next - Date.now());
      await vi.advanceTimersByTimeAsync(next - Date.now());
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000]);
    transport.serverSend(sampleHello());
    transport.serverClose(1006);
    expect((host()?.nextAttemptAt ?? 0) - Date.now()).toBe(500);
  });

  it('close 4401 ends in "unauthenticated" and 4503 in "server-stopped" without reconnecting', async () => {
    const first = setup();
    first.connection.start();
    first.transport.serverSend(sampleHello());
    first.transport.serverClose(4401);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.host()?.phase).toBe('unauthenticated');
    expect(first.transport.connectCount).toBe(1);

    const second = setup();
    second.connection.start();
    second.transport.serverSend(sampleHello());
    second.transport.serverClose(4503);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.host()?.phase).toBe('server-stopped');
    expect(second.connection.status()).toBe('closed');
    expect(second.transport.connectCount).toBe(1);
  });
});

describe('auth check before the WS', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens no WS while not signed in', async () => {
    const { transport, connection, host } = setup({
      checkAuth: () => Promise.resolve<AuthCheckResult>({ kind: 'unauthenticated', codeRejected: true }),
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.connectCount).toBe(0);
    expect(host()).toMatchObject({ phase: 'unauthenticated', authCodeRejected: true });
  });

  it('retries an unreachable server with backoff, then connects', async () => {
    let result: AuthCheckResult = { kind: 'unreachable' };
    const checkAuth = vi.fn(() => Promise.resolve(result));
    const { transport, connection, host } = setup({ checkAuth });
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(host()?.phase).toBe('reconnecting');
    expect(transport.connectCount).toBe(0);
    result = { kind: 'authenticated', serverInstanceId: SAMPLE_IDS.serverInstanceId };
    await vi.advanceTimersByTimeAsync(500);
    expect(checkAuth).toHaveBeenCalledTimes(2);
    expect(transport.connectCount).toBe(1);
  });

  it('a new instance id in the auth status triggers the full resync before the WS', async () => {
    let instance = SAMPLE_IDS.serverInstanceId;
    const { transport, connection, host } = setup({
      checkAuth: () =>
        Promise.resolve<AuthCheckResult>({ kind: 'authenticated', serverInstanceId: instance }),
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.serverSend(sampleHello());
    transport.serverSend({ type: 'summaries.snapshot', summaries: [sampleSummary()] });
    instance = sampleUuid(4242);
    transport.serverClose(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(host()?.summaries).toEqual({});
    expect(transport.connectCount).toBe(2);
  });
});

describe('presence and notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends presence after changes, debounced to one message', () => {
    const { transport, connection, store } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    store.setState({ presence: { focused: false, visible: true, typing: false } });
    store.setState({ presence: { focused: false, visible: false, typing: false }, selectedSession: KEY });
    vi.advanceTimersByTime(249);
    expect(transport.sentOfType('presence')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(transport.sentOfType('presence')).toEqual([
      {
        type: 'presence',
        presence: { focused: false, visible: false, typing: false, viewingEntryId: ENTRY },
      },
    ]);
    // No change → nothing new.
    store.setState({ presence: { focused: false, visible: false, typing: false } });
    vi.advanceTimersByTime(300);
    expect(transport.sentOfType('presence')).toHaveLength(1);
  });

  it('keeps notify messages (with session key) until notify.clear', () => {
    const { transport, connection, store } = setup();
    connection.start();
    transport.serverSend(sampleHello());
    transport.serverSend({
      type: 'notify',
      notification: {
        id: 'n1',
        kind: 'plan',
        entryId: ENTRY,
        title: 'Sample',
        delivery: 'in_app',
        at: sampleTime(),
      },
    });
    expect(store.getState().notifications).toMatchObject([{ id: 'n1', sessionKey: KEY, hostId: 'local' }]);
    transport.serverSend({ type: 'notify.clear', entryId: ENTRY });
    expect(store.getState().notifications).toEqual([]);
  });
});
