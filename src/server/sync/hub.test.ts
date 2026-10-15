import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type EntryId } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import { WS_CLOSE, parseServerMessage, type ServerMessage, type SessionOp } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleClientHello,
  sampleDetail,
  sampleId,
  sampleItems,
  samplePresence,
  sampleStatusFacts,
  sampleSummary,
  sampleUuid,
} from '@shared/samples';
import type { SessionViewState } from '@shared/sync';
import { createServerInstance } from '../config';
import { REPEATED_LOG_EVERY, REPEATED_LOG_FIRST, shouldLogRepeated } from '../lib/logger';
import { createSyncHub, type HubSocket, type SyncHub } from './hub';
import { createMemorySessionSource, type MemorySessionSource } from './memorySource';
import { CommandError } from './ports';

// ---- fakes ----

class FakeSocket extends EventEmitter implements HubSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1005, reason = ''): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit('close', code, Buffer.from(reason));
  }

  terminate(): void {
    this.close(1006);
  }

  ping(): void {
    // answered by tests via emit('pong') when needed
  }

  receive(message: unknown): void {
    this.emit('message', Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)), false);
  }

  messages(): ServerMessage[] {
    return this.sent.map((text) => {
      const parsed = parseServerMessage(text);
      if (parsed.ok !== true) throw new Error(`invalid server message ${text.slice(0, 200)}`);
      return parsed.message;
    });
  }

  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages().filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

const ENTRY = SAMPLE_IDS.entry;

function textItem(order: number, text = `item ${String(order)}`, streaming = false): TranscriptItem {
  return sampleItems.assistantText({ id: `msg_${String(order)}:0`, order, text, streaming });
}

function viewWith(items: TranscriptItem[], entryId: EntryId = ENTRY): SessionViewState {
  return {
    entryId,
    seq: 0,
    conversationId: SAMPLE_IDS.conversation,
    items,
    hasEarlier: false,
    decisions: [],
    detail: sampleDetail({ entryId }),
  };
}

const upsert = (order: number, text?: string, streaming?: boolean): SessionOp => ({
  op: 'item.upsert',
  item: textItem(order, text, streaming),
});
const delta = (order: number, append: string): SessionOp => ({
  op: 'item.delta',
  itemId: `msg_${String(order)}:0`,
  field: 'text',
  append,
});

/** Lets pending promise continuations run (setImmediate stays real). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

let source: MemorySessionSource;
let hub: SyncHub;

function connect(clientN = 1): FakeSocket {
  const socket = new FakeSocket();
  hub.handleConnection(socket);
  socket.receive(sampleClientHello({ clientId: sampleId('cl', clientN) }));
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-15T08:00:00.000Z'));
  source = createMemorySessionSource();
  source.addEntry({ entryId: ENTRY, summary: sampleSummary(), view: viewWith([textItem(1), textItem(2)]) });
  hub = createSyncHub({
    source,
    instance: createServerInstance({ serverVersion: '0.0.0-test' }),
    timing: { heartbeatMs: 0 },
  });
});

afterEach(() => {
  hub.dispose();
  vi.useRealTimers();
});

describe('handshake', () => {
  it('sends hello first and host.state + summaries after clientHello', () => {
    const socket = new FakeSocket();
    hub.handleConnection(socket);
    expect(socket.messages().map((m) => m.type)).toEqual(['hello']);
    socket.receive(sampleClientHello());
    expect(socket.messages().map((m) => m.type)).toEqual(['hello', 'host.state', 'summaries.snapshot']);
    expect(hub.presence()).toEqual([
      expect.objectContaining({
        clientId: SAMPLE_IDS.client,
        presence: samplePresence(),
        lastFocusAt: new Date(),
      }),
    ]);
  });

  it('closes with 4400 on a message before clientHello', () => {
    const socket = new FakeSocket();
    hub.handleConnection(socket);
    socket.receive({ type: 'presence', presence: samplePresence() });
    expect(socket.ofType('error')[0]).toMatchObject({
      error: { code: 'INVALID_MESSAGE' },
      inReplyTo: 'presence',
    });
    expect(socket.closedWith?.code).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it('closes with 4409 on another protocol version', () => {
    const socket = new FakeSocket();
    hub.handleConnection(socket);
    socket.receive(sampleClientHello({ protocolVersion: 2 }));
    expect(socket.ofType('error')[0]).toMatchObject({ error: { code: 'PROTOCOL_VERSION_MISMATCH' } });
    expect(socket.closedWith?.code).toBe(WS_CLOSE.PROTOCOL_VERSION_MISMATCH);
  });

  it('closes with 4400 after too many invalid messages', () => {
    const socket = connect();
    for (let i = 0; i < 11; i++) socket.receive('{bad');
    expect(socket.ofType('error')).toHaveLength(11);
    expect(socket.closedWith?.code).toBe(WS_CLOSE.PROTOCOL_ERROR);
  });

  it('forwards presence and routes notifications to the client', () => {
    const one = connect(1);
    const two = connect(2);
    one.receive({ type: 'presence', presence: samplePresence({ focused: false, viewingEntryId: null }) });
    expect(source.presenceUpdates.at(-1)).toHaveLength(2);
    hub.notify(sampleId('cl', 2), {
      id: 'n1',
      kind: 'done',
      entryId: ENTRY,
      title: 'Sample session',
      delivery: 'system',
      at: new Date().toISOString(),
    });
    expect(one.ofType('notify')).toHaveLength(0);
    expect(two.ofType('notify')).toHaveLength(1);
    hub.clearNotification(ENTRY);
    expect(one.ofType('notify.clear')).toHaveLength(1);
    one.close();
    expect(hub.presence().map((p) => p.clientId)).toEqual([sampleId('cl', 2)]);
  });
});

describe('subscriptions', () => {
  it('builds the snapshot from the current view: an op published while subscribing is not lost (R1-02)', async () => {
    const first = connect(1);
    first.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    expect(hub.inspect(ENTRY)).toMatchObject({ cached: true, seq: 0 });

    const second = connect(2);
    second.receive({ type: 'subscribe', entryId: ENTRY });
    // Same tick, before the subscribe continuation runs (reconnect + synchronous engine handler).
    hub.publishOps(ENTRY, [upsert(3)]);
    await tick();

    const snapshot = second.ofType('session.snapshot')[0];
    expect(snapshot?.seq).toBe(1);
    expect(snapshot?.items.map((i) => i.order)).toEqual([1, 2, 3]);
    expect(second.ofType('session.ops')).toEqual([]);
    // Next live op continues seamlessly after the snapshot.
    hub.publishOps(ENTRY, [upsert(4)]);
    expect(second.ofType('session.ops')[0]?.ops.map((o) => o.seq)).toEqual([2]);
    expect(first.ofType('session.ops').flatMap((m) => m.ops.map((o) => o.seq))).toEqual([1, 2]);
  });

  it('snapshot, then live ops with seq, replay from the ring buffer', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    const snapshot = socket.ofType('session.snapshot')[0];
    expect(snapshot).toMatchObject({ seq: 0, hasEarlier: false });
    expect(snapshot?.items.map((i) => i.order)).toEqual([1, 2]);

    hub.publishOps(ENTRY, [upsert(3), upsert(4)]);
    expect(socket.ofType('session.ops')[0]?.ops.map((o) => o.seq)).toEqual([1, 2]);
    expect(hub.inspect(ENTRY)).toMatchObject({ seq: 2, cached: true, ringSize: 2, subscribers: 1 });

    socket.receive({ type: 'subscribe', entryId: ENTRY, sinceSeq: 1 });
    await tick();
    expect(socket.ofType('session.ops')[1]?.ops.map((o) => o.seq)).toEqual([2]);
    // the re-subscribe does not count twice
    expect(source.subscriberCounts).toEqual([{ entryId: ENTRY, count: 1 }]);
  });

  it('answers with a snapshot when the gap is outside the ring buffer', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    const ops: SessionOp[] = [];
    for (let i = 0; i < LIMITS.ringBufferOps + 5; i++) ops.push(upsert(3 + (i % 50)));
    hub.publishOps(ENTRY, ops);
    expect(hub.inspect(ENTRY)?.ringSize).toBe(LIMITS.ringBufferOps);
    socket.receive({ type: 'subscribe', entryId: ENTRY, sinceSeq: 2 });
    await tick();
    const snapshots = socket.ofType('session.snapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.seq).toBe(LIMITS.ringBufferOps + 5);
  });

  it('assigns seqs to ops of entries nobody watches without keeping them', () => {
    hub.publishOps(ENTRY, [upsert(3)]);
    expect(hub.inspect(ENTRY)).toMatchObject({ seq: 1, cached: false, ringSize: 0 });
  });

  it('keeps the hub-owned seq for a loaded view (R0-20) and trims it to the snapshot size', async () => {
    const items = Array.from({ length: LIMITS.snapshotItems + 10 }, (_, i) => textItem(i + 1));
    source.addEntry({ entryId: ENTRY, view: { ...viewWith(items), seq: 77 } });
    hub.publishOps(ENTRY, [upsert(500)]);
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    const snapshot = socket.ofType('session.snapshot')[0];
    expect(snapshot?.seq).toBe(1);
    expect(snapshot?.items).toHaveLength(LIMITS.snapshotItems);
    expect(snapshot?.hasEarlier).toBe(true);
  });

  it('keeps snapshots under snapshotMaxChars, newest item always included', async () => {
    const big = 'x'.repeat(600 * 1024);
    source.addEntry({ entryId: ENTRY, view: viewWith([1, 2, 3, 4, 5].map((n) => textItem(n, big))) });
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    const snapshot = socket.ofType('session.snapshot')[0];
    expect(snapshot?.items.map((i) => i.order)).toEqual([3, 4, 5]);
    expect(snapshot?.hasEarlier).toBe(true);
  });

  it('shares one loadView between concurrent subscribers and answers unknown entries', async () => {
    source.loadViewDelayMs = 0;
    const one = connect(1);
    const two = connect(2);
    one.receive({ type: 'subscribe', entryId: ENTRY });
    two.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    expect(source.loadViewCalls).toEqual([ENTRY]);
    one.receive({ type: 'subscribe', entryId: sampleId('en', 9) });
    await tick();
    expect(one.ofType('session.unavailable')[0]).toMatchObject({ error: { code: 'ENTRY_NOT_FOUND' } });
    expect(hub.inspect(sampleId('en', 9))).toBeNull();
  });

  it('drops a pending subscribe after unsubscribe', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    socket.receive({ type: 'unsubscribe', entryId: ENTRY });
    await tick();
    expect(socket.ofType('session.snapshot')).toHaveLength(0);
    expect(hub.inspect(ENTRY)?.subscribers).toBe(0);
  });

  it('evicts the cache after the grace period without subscribers, the seq stays', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    hub.publishOps(ENTRY, [upsert(3)]);
    socket.receive({ type: 'unsubscribe', entryId: ENTRY });
    expect(source.subscriberCounts.at(-1)).toEqual({ entryId: ENTRY, count: 0 });
    vi.advanceTimersByTime(59_000);
    expect(hub.inspect(ENTRY)).toMatchObject({ cached: true, ringSize: 1 });
    vi.advanceTimersByTime(2_000);
    expect(hub.inspect(ENTRY)).toMatchObject({ seq: 1, cached: false, ringSize: 0 });
    // Replay from seq 0 is no longer possible → snapshot with the current seq.
    socket.receive({ type: 'subscribe', entryId: ENTRY, sinceSeq: 0 });
    await tick();
    expect(socket.ofType('session.snapshot').at(-1)?.seq).toBe(1);
  });

  it('notifies subscribers when a summary is removed', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    hub.removeSummary(ENTRY);
    expect(socket.ofType('summary.remove')).toEqual([{ type: 'summary.remove', entryId: ENTRY }]);
    expect(socket.ofType('session.unavailable')[0]).toMatchObject({ error: { code: 'ENTRY_NOT_FOUND' } });
  });
});

describe('delta coalescing', () => {
  beforeEach(() => {
    source.addEntry({ entryId: ENTRY, view: viewWith([textItem(1, '', true)]) });
  });

  it('merges deltas per item and field into one op, flushed after deltaFlushMs', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    hub.publishOps(ENTRY, [delta(1, 'Hel')]);
    hub.publishOps(ENTRY, [delta(1, 'lo'), delta(1, '!')]);
    expect(socket.ofType('session.ops')).toHaveLength(0);
    vi.advanceTimersByTime(LIMITS.deltaFlushMs);
    const ops = socket.ofType('session.ops');
    expect(ops).toHaveLength(1);
    expect(ops[0]?.ops).toEqual([
      {
        seq: 1,
        at: expect.any(String) as string,
        op: { op: 'item.delta', itemId: 'msg_1:0', field: 'text', append: 'Hello!' },
      },
    ]);
  });

  it('flushes pending deltas before any other op of the entry', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    hub.publishOps(ENTRY, [delta(1, 'a'), delta(1, 'b')]);
    hub.publishOps(ENTRY, [upsert(1, 'ab')]);
    const frames = socket.ofType('session.ops');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.ops.map((o) => [o.seq, o.op.op])).toEqual([
      [1, 'item.delta'],
      [2, 'item.upsert'],
    ]);
    vi.advanceTimersByTime(100);
    expect(socket.ofType('session.ops')).toHaveLength(1);
    // the hub's view applied both: a new subscriber sees the final text
    const other = connect(2);
    other.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    expect(other.ofType('session.snapshot')[0]?.items[0]).toMatchObject({ text: 'ab', streaming: false });
  });
});

describe('summaries (channel 1)', () => {
  it('sends status changes immediately and throttles context/activity to 1/s per entry', () => {
    const socket = connect();
    hub.publishSummary(sampleSummary(), false);
    expect(socket.ofType('summary.upsert')).toHaveLength(1);

    hub.publishSummary(sampleSummary({ lastActivityAt: new Date(Date.now() + 1).toISOString() }), false);
    hub.publishSummary(sampleSummary({ lastActivityAt: new Date(Date.now() + 2).toISOString() }), false);
    expect(socket.ofType('summary.upsert')).toHaveLength(1);

    vi.advanceTimersByTime(LIMITS.summaryThrottleMs);
    const sent = socket.ofType('summary.upsert');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.summary.lastActivityAt).toBe(
      new Date(Date.parse('2026-10-15T08:00:00.000Z') + 2).toISOString(),
    );

    hub.publishSummary(sampleSummary({ status: sampleStatusFacts({ runState: 'working' }) }), false);
    expect(socket.ofType('summary.upsert')).toHaveLength(3);
    hub.publishSummary(
      sampleSummary({ status: sampleStatusFacts({ runState: 'working' }), lastResultExcerpt: 'x' }),
      true,
    );
    expect(socket.ofType('summary.upsert')).toHaveLength(4);
  });

  it('broadcasts host state', () => {
    const socket = connect();
    hub.publishHostState({ ...source.host, setupRequired: true });
    expect(socket.ofType('host.state').at(-1)?.host.setupRequired).toBe(true);
  });
});

describe('commands', () => {
  it('maps CommandError, invalid results and crashes to ack{ok:false}', async () => {
    const socket = connect();
    source.setHandler('session.interrupt', () => {
      throw new CommandError({ code: 'SESSION_NOT_RUNNING', params: {} });
    });
    source.setHandler('session.close', () => ({ unexpected: 1 }) as unknown as Record<string, never>);
    source.setHandler('session.resume', () => {
      throw new Error('boom');
    });
    socket.receive({ type: 'cmd', cmdId: sampleUuid(1), cmd: { name: 'session.interrupt', entryId: ENTRY } });
    socket.receive({ type: 'cmd', cmdId: sampleUuid(2), cmd: { name: 'session.close', entryId: ENTRY } });
    socket.receive({ type: 'cmd', cmdId: sampleUuid(3), cmd: { name: 'session.resume', entryId: ENTRY } });
    await tick();
    const acks = socket.ofType('ack');
    expect(acks.find((a) => a.cmdId === sampleUuid(1))).toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_RUNNING' },
    });
    // z.object strips unknown keys: the result is valid but reduced to {}
    expect(acks.find((a) => a.cmdId === sampleUuid(2))).toMatchObject({ ok: true, result: {} });
    expect(acks.find((a) => a.cmdId === sampleUuid(3))).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('rejects results that do not match the command result schema', async () => {
    const socket = connect();
    source.setHandler('session.sendPrompt', () => ({ messageUuid: 'not-a-uuid' }));
    socket.receive({
      type: 'cmd',
      cmdId: sampleUuid(4),
      cmd: { name: 'session.sendPrompt', entryId: ENTRY, prompt: { text: 'hi' } },
    });
    await tick();
    expect(socket.ofType('ack')[0]).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR', params: { reason: 'invalid_result' } },
    });
  });

  it('passes clientId and cmdId as context and caches by cmdId host-wide', async () => {
    const one = connect(1);
    const two = connect(2);
    const cmd = {
      type: 'cmd',
      cmdId: sampleUuid(5),
      cmd: { name: 'session.setPinned', entryId: ENTRY, pinned: true },
    };
    one.receive(cmd);
    await tick();
    two.receive(cmd);
    await tick();
    expect(source.commands).toHaveLength(1);
    expect(source.commands[0]?.ctx).toEqual({ clientId: sampleId('cl', 1), cmdId: sampleUuid(5) });
    expect(two.ofType('ack')[0]).toEqual(one.ofType('ack')[0]);
  });

  it('expires cached acks after the TTL', async () => {
    const socket = connect();
    const cmd = {
      type: 'cmd',
      cmdId: sampleUuid(6),
      cmd: { name: 'session.setPinned', entryId: ENTRY, pinned: true },
    };
    socket.receive(cmd);
    await tick();
    vi.advanceTimersByTime(LIMITS.cmdCacheTtlMs + 1);
    socket.receive(cmd);
    await tick();
    expect(source.commands).toHaveLength(2);
  });

  it('caches validation failures like results', () => {
    const socket = connect();
    const bad = {
      type: 'cmd',
      cmdId: sampleUuid(7),
      cmd: { name: 'session.rename', entryId: ENTRY, title: '' },
    };
    socket.receive(bad);
    socket.receive(bad);
    const acks = socket.ofType('ack');
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual(acks[0]);
    expect(acks[0]).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', params: { path: 'cmd.title' } },
    });
    expect(source.commands).toHaveLength(0);
  });
});

describe('outgoing validation (R0-28)', () => {
  it('throws in test mode for ops that do not survive sessionOpSchema.parse unchanged', () => {
    const item = { ...textItem(3), localCommand: undefined };
    expect(() => {
      hub.publishOps(ENTRY, [{ op: 'item.upsert', item: item as unknown as TranscriptItem }]);
    }).toThrow(/invalid op item.upsert/);
  });

  it('drops invalid ops in log mode and publishes the rest', async () => {
    const lenient = createSyncHub({
      source,
      instance: createServerInstance({ serverVersion: '0' }),
      validation: 'log',
      timing: { heartbeatMs: 0 },
    });
    const socket = new FakeSocket();
    lenient.handleConnection(socket);
    socket.receive(sampleClientHello());
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    const broken = { op: 'item.remove', itemId: '' } as unknown as SessionOp;
    lenient.publishOps(ENTRY, [broken, upsert(3)]);
    expect(socket.ofType('session.ops')[0]?.ops.map((o) => o.op.op)).toEqual(['item.upsert']);
    // R3-05: counted for the diagnosis; the seq stays gapless (the dropped op got none).
    expect(lenient.stats()).toEqual({ invalidOutgoing: 1 });
    expect(socket.ofType('session.ops')[0]?.ops[0]?.seq).toBe(lenient.inspect(ENTRY)?.seq ?? 0);
    lenient.dispose();
  });

  it('log mode logs the first failures and then only every 100th (R3-05)', () => {
    const logged = Array.from({ length: 1000 }, (_, i) => i + 1).filter((n) => shouldLogRepeated(n));
    expect(logged.slice(0, REPEATED_LOG_FIRST)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(logged.slice(REPEATED_LOG_FIRST)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(REPEATED_LOG_EVERY).toBe(100);
  });
});

describe('closeAll', () => {
  it('closes every socket with the given code and cleans up subscriptions', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    hub.closeAll(WS_CLOSE.SERVER_SHUTDOWN);
    expect(socket.closedWith?.code).toBe(WS_CLOSE.SERVER_SHUTDOWN);
    expect(hub.inspect(ENTRY)?.subscribers).toBe(0);
    expect(hub.presence()).toEqual([]);
  });

  it('closes slow consumers (1013)', async () => {
    const socket = connect();
    socket.receive({ type: 'subscribe', entryId: ENTRY });
    await tick();
    socket.bufferedAmount = 64 * 1024 * 1024;
    hub.publishOps(ENTRY, [upsert(3)]);
    expect(socket.closedWith?.code).toBe(1013);
  });
});
