import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { parseServerMessage, type Command, type ServerMessage } from '@shared/protocol';
import { SAMPLE_IDS, sampleDecisions, sampleItems, sampleSessionSnapshot } from '@shared/samples';
import { FakeHost } from './fake-host';
import { createMemoryTransport } from './transport';

const ENTRY = SAMPLE_IDS.entry;

function connect(transport: ReturnType<typeof createMemoryTransport>) {
  const received: ServerMessage[] = [];
  transport.connect(
    (text) => {
      const parsed = parseServerMessage(text);
      if (parsed.ok === true) received.push(parsed.message);
    },
    () => undefined,
  );
  return received;
}

function command(transport: ReturnType<typeof createMemoryTransport>, cmd: Command, cmdId: string): void {
  transport.send(JSON.stringify({ type: 'cmd', cmdId, cmd }));
}

function ackOf(received: readonly ServerMessage[], cmdId: string) {
  return received.find((message) => message.type === 'ack' && message.cmdId === cmdId);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FakeHost defaults for WP-15/16 demos (R1W-22)', () => {
  it('decision.respond resolves the decision and writes the outcome into the gating tool_call', () => {
    const transport = createMemoryTransport();
    const decision = sampleDecisions.plan();
    const toolCall = sampleItems.toolCall({
      toolUseId: decision.toolUseId,
      toolName: 'ExitPlanMode',
      status: 'awaiting_decision',
      result: null,
      decision: { decisionId: decision.id, kind: 'plan', planVersion: 1, outcome: null },
    });
    const host = new FakeHost({
      transport,
      sessions: [sampleSessionSnapshot({ items: [toolCall], decisions: [decision] })],
    });
    connect(transport);
    command(
      transport,
      {
        name: 'decision.respond',
        entryId: ENTRY,
        decisionId: decision.id,
        response: { kind: 'plan', response: { behavior: 'approve', mode: 'default', editedPlan: null } },
      },
      SAMPLE_IDS.cmdId,
    );
    const view = host.view(ENTRY);
    expect(view?.decisions).toEqual([]);
    expect(view?.items[0]).toMatchObject({
      kind: 'tool_call',
      status: 'done',
      decision: {
        decisionId: decision.id,
        outcome: { type: 'plan_approved', mode: 'default', edited: false },
      },
    });
    host.dispose();
  });

  it('session.interrupt aborts a running stream (aborted, not streaming)', () => {
    vi.useFakeTimers();
    const transport = createMemoryTransport();
    const host = new FakeHost({ transport, sessions: [sampleSessionSnapshot({ items: [] })] });
    connect(transport);
    const item = sampleItems.assistantText({ id: 'live:0', order: 1, text: '', streaming: true });
    host.streamAssistantText(ENTRY, { item, text: 'abcdefghijkl', chunkSize: 3, intervalMs: 10 });
    vi.advanceTimersByTime(25);
    command(transport, { name: 'session.interrupt', entryId: ENTRY }, SAMPLE_IDS.cmdId);
    expect(host.view(ENTRY)?.items[0]).toMatchObject({ text: 'abcdef', streaming: false, aborted: true });
    vi.advanceTimersByTime(100);
    expect(host.view(ENTRY)?.items[0]).toMatchObject({ text: 'abcdef' });
    host.dispose();
  });

  it('transcript.loadEarlier serves the items before the oldest loaded one', () => {
    const transport = createMemoryTransport();
    const count = LIMITS.snapshotItems + 3;
    const items = Array.from({ length: count }, (_, i) =>
      sampleItems.userMessage({ id: `u${String(i + 1)}`, order: i + 1 }),
    );
    const host = new FakeHost({ transport, sessions: [sampleSessionSnapshot({ items })] });
    const received = connect(transport);
    transport.send(JSON.stringify({ type: 'subscribe', entryId: ENTRY }));
    const snapshot = received.find((message) => message.type === 'session.snapshot');
    expect(snapshot).toMatchObject({ hasEarlier: true });
    command(
      transport,
      {
        name: 'transcript.loadEarlier',
        entryId: ENTRY,
        conversationId: SAMPLE_IDS.conversation,
        beforeOrder: 4,
        limit: 2,
      },
      SAMPLE_IDS.cmdId,
    );
    expect(ackOf(received, SAMPLE_IDS.cmdId)).toMatchObject({
      ok: true,
      result: { items: [{ id: 'u2' }, { id: 'u3' }], hasEarlier: true },
    });
    host.dispose();
  });
});
