import { describe, expect, it } from 'vitest';
import {
  SAMPLE_IDS,
  sampleHostState,
  sampleId,
  sampleItems,
  samplePresence,
  sampleSessionSnapshot,
  sampleSummary,
} from '@shared/samples';
import { viewStateFromSnapshot } from '@shared/sync';
import { createMemoryPublisher } from './memoryPublisher';

const E = SAMPLE_IDS.entry;

describe('createMemoryPublisher', () => {
  it('records ops per entry and applies them to a set view base', () => {
    const pub = createMemoryPublisher();
    pub.setViewBase(E, viewStateFromSnapshot(sampleSessionSnapshot({ items: [] })));
    pub.publishOps(E, [{ op: 'item.upsert', item: sampleItems.userMessage() }]);
    pub.publishOps(E, [{ op: 'item.upsert', item: sampleItems.assistantText() }]);
    expect(pub.opsOf(E)).toHaveLength(2);
    expect(pub.allOps.map((o) => o.entryId)).toEqual([E, E]);
    expect(pub.view(E)?.items.map((i) => i.kind)).toEqual(['user_message', 'assistant_text']);
    expect(pub.view(sampleId('en', 2))).toBeNull();
  });

  it('validates like the hub: an op that changes under parse throws', () => {
    const pub = createMemoryPublisher();
    const withExtraKey = { ...sampleItems.userMessage(), bogus: true };
    expect(() => {
      pub.publishOps(E, [{ op: 'item.upsert', item: withExtraKey }]);
    }).toThrow(/changes under parse/);
    const summary = { ...sampleSummary(), extra: 1 };
    expect(() => {
      pub.publishSummary(summary, false);
    }).toThrow(/invalid summary/);
    expect(() => {
      pub.publishHostState({ ...sampleHostState(), profiles: [] });
    }).toThrow(/invalid host state/);
    // validate: false accepts anything.
    const loose = createMemoryPublisher({ validate: false });
    loose.publishHostState({ ...sampleHostState(), profiles: [] });
    expect(loose.hostStates).toHaveLength(1);
  });

  it('summaries, notifications, presence, clear, close', () => {
    const pub = createMemoryPublisher();
    pub.publishSummary(sampleSummary(), true);
    expect(pub.summaryOf(E)).toEqual(sampleSummary());
    pub.removeSummary(E);
    expect(pub.summaryOf(E)).toBeNull();
    pub.notify(sampleId('cl', 1), {
      id: 'n1',
      kind: 'done',
      entryId: E,
      title: 'T',
      delivery: 'in_app',
      at: '2026-10-15T08:00:00.000Z',
    });
    expect(pub.notifications).toHaveLength(1);
    pub.setPresence([
      { clientId: sampleId('cl', 1), presence: samplePresence(), lastFocusAt: null, connectedAt: new Date() },
    ]);
    expect(pub.presence()).toHaveLength(1);
    pub.clearNotification(E);
    pub.closeAll(4503);
    expect(pub.cleared).toEqual([E]);
    expect(pub.closedWith).toEqual([4503]);
  });

  it('waitFor resolves after a later publish and times out otherwise', async () => {
    const pub = createMemoryPublisher();
    const waiting = pub.waitFor(() => pub.summaries.length > 0, 1000);
    setTimeout(() => {
      pub.publishSummary(sampleSummary(), false);
    }, 5);
    await expect(waiting).resolves.toBeUndefined();
    await expect(pub.waitFor(() => false, 20)).rejects.toThrow(/timeout/);
  });
});
