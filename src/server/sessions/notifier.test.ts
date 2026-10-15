import { describe, expect, it } from 'vitest';
import type { EntryId } from '@shared/common';
import { SAMPLE_TIME, sampleId, sampleStatusFacts } from '@shared/samples';
import { DONE_NOTIFY_MIN_TURN_MS } from '@shared/status';
import type { ClientPresence } from '../sync/ports';
import { chooseChannel, decisionsCleared, isViewedByVisibleClient, planNotification } from './notifier';

const ENTRY: EntryId = sampleId('en', 1);
const OTHER: EntryId = sampleId('en', 2);
const NOW = new Date(SAMPLE_TIME);

function client(
  n: number,
  p: { focused: boolean; visible: boolean; viewing: EntryId | null },
  lastFocusSec: number | null = n,
): ClientPresence {
  return {
    clientId: sampleId('cl', n),
    presence: { focused: p.focused, visible: p.visible, viewingEntryId: p.viewing, typing: false },
    lastFocusAt: lastFocusSec === null ? null : new Date(Date.parse(SAMPLE_TIME) + lastFocusSec * 1000),
    connectedAt: new Date(Date.parse(SAMPLE_TIME) + n),
  };
}

describe('chooseChannel (A.9)', () => {
  it.each<[string, ClientPresence[], { client: number; delivery: 'in_app' | 'system'; min: number } | null]>([
    ['no client', [], null],
    [
      'focused + visible window shows the entry',
      [client(1, { focused: true, visible: true, viewing: ENTRY })],
      null,
    ],
    [
      'focused + visible window elsewhere → in_app there',
      [client(1, { focused: true, visible: true, viewing: OTHER })],
      { client: 1, delivery: 'in_app', min: DONE_NOTIFY_MIN_TURN_MS },
    ],
    [
      'only background windows → system to the last focused',
      [
        client(1, { focused: false, visible: true, viewing: ENTRY }, 5),
        client(2, { focused: false, visible: false, viewing: null }, 9),
      ],
      { client: 2, delivery: 'system', min: 0 },
    ],
    [
      'never focused → the most recently connected',
      [
        client(1, { focused: false, visible: false, viewing: null }, null),
        client(2, { focused: false, visible: false, viewing: null }, null),
      ],
      { client: 2, delivery: 'system', min: 0 },
    ],
    [
      'several focused windows → the most recently focused one',
      [
        client(1, { focused: true, visible: true, viewing: OTHER }, 3),
        client(2, { focused: true, visible: true, viewing: null }, 7),
      ],
      { client: 2, delivery: 'in_app', min: DONE_NOTIFY_MIN_TURN_MS },
    ],
  ])('%s', (_name, clients, expected) => {
    const channel = chooseChannel(clients, ENTRY);
    expect(channel).toEqual(
      expected === null
        ? null
        : {
            clientId: sampleId('cl', expected.client),
            delivery: expected.delivery,
            minDoneTurnMs: expected.min,
          },
    );
  });

  it('isViewedByVisibleClient needs visible + viewing (focus not required)', () => {
    expect(
      isViewedByVisibleClient([client(1, { focused: false, visible: true, viewing: ENTRY })], ENTRY),
    ).toBe(true);
    expect(
      isViewedByVisibleClient([client(1, { focused: true, visible: false, viewing: ENTRY })], ENTRY),
    ).toBe(false);
    expect(
      isViewedByVisibleClient([client(1, { focused: true, visible: true, viewing: OTHER })], ENTRY),
    ).toBe(false);
  });
});

describe('planNotification', () => {
  const working = sampleStatusFacts({ runState: 'working' });
  const shortDone = sampleStatusFacts({
    runState: 'idle',
    unread: true,
    lastTurn: { outcome: 'success', endedAt: SAMPLE_TIME, durationMs: 1_000 },
  });

  it('done of a short turn: system (unfocused) yes, in_app (focused elsewhere) no', () => {
    const away = [client(1, { focused: false, visible: false, viewing: null })];
    expect(planNotification(working, shortDone, NOW, away, ENTRY)).toEqual({
      clientId: sampleId('cl', 1),
      kind: 'done',
      delivery: 'system',
    });
    const elsewhere = [client(1, { focused: true, visible: true, viewing: OTHER })];
    expect(planNotification(working, shortDone, NOW, elsewhere, ENTRY)).toBeNull();
  });

  it('a new decision is reported with its kind (R0-13); cleared when the last one is gone', () => {
    const one = sampleStatusFacts({
      runState: 'working',
      decisions: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
    });
    const two = sampleStatusFacts({
      runState: 'working',
      decisions: { permission: 1, question: 1, plan: 0, oldestKind: 'permission', expired: 0 },
    });
    const elsewhere = [client(1, { focused: true, visible: true, viewing: OTHER })];
    expect(planNotification(working, one, NOW, elsewhere, ENTRY)?.kind).toBe('permission');
    expect(planNotification(one, two, NOW, elsewhere, ENTRY)?.kind).toBe('question');
    expect(decisionsCleared(two, working)).toBe(true);
    expect(decisionsCleared(two, one)).toBe(false);
    expect(decisionsCleared(working, working)).toBe(false);
  });
});
