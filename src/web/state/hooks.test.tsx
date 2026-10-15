import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionKey } from '@shared/common';
import {
  SAMPLE_IDS,
  sampleDecisions,
  sampleItems,
  sampleSessionSnapshot,
  sampleStatusFacts,
  sampleSummary,
} from '@shared/samples';
import { refreshClock } from './clock';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost } from './fake-host';
import {
  sendCommand,
  useAttentionCount,
  useDecisions,
  useDisplayStatus,
  useItem,
  useItemIds,
  useSelectedSession,
  useSessionView,
  useSummaries,
} from './hooks';
import { startSelectionSync } from './selection';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';

const KEY = makeSessionKey('local', SAMPLE_IDS.entry);

function connectFakeHost(options: Partial<ConstructorParameters<typeof FakeHost>[0]> = {}) {
  const transport = createMemoryTransport();
  const host = new FakeHost({
    transport,
    summaries: [sampleSummary()],
    sessions: [sampleSessionSnapshot()],
    ...options,
  });
  const connection = createHostConnection({
    hostId: 'local',
    createTransport: () => transport,
    clientId: SAMPLE_IDS.client,
    unsubscribeDelayMs: 0,
    scheduleFrame: (callback) => {
      queueMicrotask(callback);
    },
  });
  registerConnection(connection);
  connection.start();
  return { transport, host, connection };
}

afterEach(() => {
  unregisterConnection();
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

describe('session hooks', () => {
  it('useSessionView subscribes while mounted and follows live ops', async () => {
    const { host } = connectFakeHost();
    const { result, unmount } = renderHook(() => useSessionView(KEY));
    expect(host.subscribed.has(SAMPLE_IDS.entry)).toBe(true);
    expect(result.current?.items).toHaveLength(5);
    await act(async () => {
      host.pushOps(SAMPLE_IDS.entry, [{ op: 'item.remove', itemId: `${SAMPLE_IDS.messageId}:0` }]);
      await Promise.resolve();
    });
    expect(result.current?.items).toHaveLength(4);
    unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(host.subscribed.has(SAMPLE_IDS.entry)).toBe(false);
  });

  it('useItem re-renders for its own item only; useItemIds stays stable on deltas', async () => {
    const { host } = connectFakeHost();
    const streamId = 'msg_live:0';
    host.pushOps(SAMPLE_IDS.entry, [
      {
        op: 'item.upsert',
        item: sampleItems.assistantText({
          id: streamId,
          order: 6,
          messageId: 'msg_live',
          blockIndex: 0,
          text: '',
          streaming: true,
        }),
      },
    ]);
    let idsRenders = 0;
    let otherRenders = 0;
    function Ids() {
      const ids = useItemIds(KEY);
      idsRenders++;
      return <span data-testid="ids">{ids.length}</span>;
    }
    function Streaming() {
      const item = useItem(KEY, streamId);
      return <span data-testid="stream">{item?.kind === 'assistant_text' ? item.text : ''}</span>;
    }
    function Other() {
      useItem(KEY, SAMPLE_IDS.messageUuid);
      otherRenders++;
      return null;
    }
    render(
      <>
        <Ids />
        <Streaming />
        <Other />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('ids').textContent).toBe('6');
    const idsBefore = idsRenders;
    const otherBefore = otherRenders;
    await act(async () => {
      host.pushOps(SAMPLE_IDS.entry, [{ op: 'item.delta', itemId: streamId, field: 'text', append: 'Hi' }]);
      await Promise.resolve();
    });
    expect(screen.getByTestId('stream').textContent).toBe('Hi');
    expect(idsRenders).toBe(idsBefore);
    expect(otherRenders).toBe(otherBefore);
  });

  it('useDecisions lists open decisions (subscribing on its own)', () => {
    const { host } = connectFakeHost({
      sessions: [sampleSessionSnapshot({ decisions: [sampleDecisions.permission()] })],
    });
    const { result } = renderHook(() => useDecisions(KEY));
    expect(host.subscribed.has(SAMPLE_IDS.entry)).toBe(true);
    expect(result.current.map((decision) => decision.id)).toEqual([SAMPLE_IDS.decision]);
  });

  it('useSummaries and useAttentionCount reflect channel 1', () => {
    const { host } = connectFakeHost();
    const { result } = renderHook(() => ({ summaries: useSummaries(), attention: useAttentionCount() }));
    expect(result.current.summaries.map((entry) => entry.sessionKey)).toEqual([KEY]);
    expect(result.current.attention).toBe(0);
    const first = result.current.summaries;
    act(() => {
      host.patchSummary(
        SAMPLE_IDS.entry,
        {},
        {
          decisions: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
          runState: 'working',
        },
      );
    });
    expect(result.current.attention).toBe(1);
    expect(result.current.summaries).not.toBe(first);
  });
});

describe('useDisplayStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-15T08:00:00.000Z') });
    refreshClock();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the status and re-renders when the rate limit ends', () => {
    connectFakeHost({
      summaries: [
        sampleSummary({
          status: sampleStatusFacts({ runState: 'idle', rateLimitedUntil: '2026-10-15T08:00:10.000Z' }),
        }),
      ],
    });
    const { result } = renderHook(() => useDisplayStatus(KEY));
    expect(result.current?.kind).toBe('rate-limited');
    expect(result.current?.rateLimitedUntil).toBe('2026-10-15T08:00:10.000Z');
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(result.current?.kind).toBe('idle');
  });

  it('is null for unknown sessions', () => {
    const { result } = renderHook(() => useDisplayStatus('local:en_ffffffffffffffffffffffffffffffff'));
    expect(result.current).toBeNull();
  });
});

describe('selection', () => {
  it('useSelectedSession mirrors #session= and follows hashchange', () => {
    const stop = startSelectionSync();
    const { result } = renderHook(() => useSelectedSession());
    act(() => {
      result.current[1](KEY);
    });
    expect(window.location.hash).toBe(`#session=${KEY}`);
    expect(clientStore.getState().selectedSession).toBe(KEY);
    act(() => {
      window.location.hash = `#session=${SAMPLE_IDS.entry}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current[0]).toBe(KEY);
    act(() => {
      result.current[1](null);
    });
    expect(window.location.hash).toBe('');
    stop();
  });
});

describe('sendCommand', () => {
  it('routes by session key and rejects invalid keys', async () => {
    connectFakeHost();
    await expect(sendCommand(KEY, { name: 'session.interrupt', entryId: SAMPLE_IDS.entry })).resolves.toEqual(
      { stillQueued: [] },
    );
    await expect(
      sendCommand('nonsense', { name: 'session.interrupt', entryId: SAMPLE_IDS.entry }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
