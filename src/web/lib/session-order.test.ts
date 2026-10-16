import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared/model';
import { sampleId, sampleStatusFacts, sampleSummary } from '@shared/samples';
import {
  archivedOrder,
  flatSidebarOrder,
  groupSessions,
  groupedOrder,
  nextWaiting,
  waitingFirst,
  type OrderedSession,
} from './session-order';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

interface Entry {
  key: string;
  hostId?: string;
  summary: SessionSummary;
}

function entry(n: number, p: Partial<SessionSummary> & { waiting?: boolean; minutes?: number }): Entry {
  const { waiting = false, minutes = n, ...rest } = p;
  return {
    key: `k${String(n)}`,
    summary: sampleSummary({
      entryId: sampleId('en', n),
      title: `Session ${String(n)}`,
      lastActivityAt: minutesAgo(minutes),
      status: sampleStatusFacts(
        waiting
          ? {
              runState: 'working',
              decisions: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
            }
          : { runState: 'idle' },
      ),
      ...rest,
    }),
  };
}

const keys = (list: readonly OrderedSession<Entry>[]) => list.map((item) => item.entry.key);

describe('flatSidebarOrder', () => {
  it('puts pinned entries first, then waiting → activity, and leaves archived ones out', () => {
    const entries = [
      entry(1, { minutes: 1 }),
      entry(2, { minutes: 50, pinned: true }),
      entry(3, { minutes: 30, waiting: true }),
      entry(4, { minutes: 2, archived: true }),
      entry(5, { minutes: 5, pinned: true, waiting: true }),
    ];
    expect(keys(flatSidebarOrder(entries, NOW))).toEqual(['k5', 'k2', 'k3', 'k1']);
  });
});

describe('archivedOrder', () => {
  it('lists only archived entries, newest first', () => {
    const entries = [
      entry(1, { archived: true, minutes: 90 }),
      entry(2, {}),
      entry(3, { archived: true, minutes: 5 }),
    ];
    expect(keys(archivedOrder(entries, NOW))).toEqual(['k3', 'k1']);
  });
});

describe('groupSessions', () => {
  it('groups case-insensitively by folder, groups with attention first, then newest activity', () => {
    const entries = [
      entry(1, { cwd: 'D:\\work\\api', minutes: 1 }),
      entry(2, { cwd: 'd:/WORK/api/', minutes: 40 }),
      entry(3, { cwd: 'D:\\work\\web', minutes: 60, waiting: true }),
      entry(4, { cwd: 'D:\\work\\docs', minutes: 10 }),
      entry(5, { cwd: 'D:\\work\\api', minutes: 3, pinned: true }),
      entry(6, { cwd: 'D:\\work\\web', minutes: 2, archived: true }),
    ];
    const groups = groupSessions(entries, NOW);
    expect(groups.map((group) => group.key)).toEqual(['d:\\work\\web', 'd:\\work\\api', 'd:\\work\\docs']);
    const api = groups[1];
    // Spelling of the newest entry; pinned first inside the group.
    expect(api?.cwd).toBe('D:\\work\\api');
    expect(api?.label).toBe('work\\api');
    expect(api?.sessions.map((item) => item.entry.key)).toEqual(['k5', 'k1', 'k2']);
    expect(groups[0]?.attention).toBe(true);
    expect(keys(groupedOrder(groups))).toEqual(['k3', 'k5', 'k1', 'k2', 'k4']);
  });

  it('keeps hosts apart (multi-host)', () => {
    const a = { ...entry(1, { cwd: 'D:\\x' }), hostId: 'local' };
    const b = { ...entry(2, { cwd: 'D:\\x' }), hostId: 'vm' };
    expect(groupSessions([a, b], NOW)).toHaveLength(2);
  });
});

describe('nextWaiting (Alt+N, ADR-118)', () => {
  const order = flatSidebarOrder(
    [
      entry(1, { minutes: 1 }),
      entry(2, { minutes: 2, waiting: true }),
      entry(3, { minutes: 3 }),
      entry(4, { minutes: 4, waiting: true }),
    ],
    NOW,
  );
  const keyOf = (item: Entry) => item.key;

  it('goes to the next waiting entry after the selection, cyclically', () => {
    expect(keys(order)).toEqual(['k2', 'k4', 'k1', 'k3']);
    expect(nextWaiting(order, null, keyOf)?.key).toBe('k2');
    expect(nextWaiting(order, 'k2', keyOf)?.key).toBe('k4');
    expect(nextWaiting(order, 'k4', keyOf)?.key).toBe('k2');
    expect(nextWaiting(order, 'k1', keyOf)?.key).toBe('k2');
    expect(nextWaiting(order, 'unknown', keyOf)?.key).toBe('k2');
  });

  it('stays on the only waiting entry and returns null without one', () => {
    const single = flatSidebarOrder([entry(1, { waiting: true }), entry(2, {})], NOW);
    expect(nextWaiting(single, 'k1', keyOf)?.key).toBe('k1');
    expect(nextWaiting(flatSidebarOrder([entry(1, {})], NOW), null, keyOf)).toBeNull();
  });
});

describe('waitingFirst', () => {
  it('moves waiting entries to the front and keeps both orders', () => {
    const pinned = flatSidebarOrder(
      [entry(1, { pinned: true }), entry(2, { waiting: true }), entry(3, {}), entry(4, { waiting: true })],
      NOW,
    );
    expect(keys(pinned)).toEqual(['k1', 'k2', 'k4', 'k3']);
    expect(keys(waitingFirst(pinned))).toEqual(['k2', 'k4', 'k1', 'k3']);
  });
});
