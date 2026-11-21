import { describe, expect, it } from 'vitest';
import type { EntryId } from '@shared/common';
import type { NotificationSettings } from '@shared/model';
import { SAMPLE_TIME, sampleId, sampleNotificationSettings, sampleStatusFacts } from '@shared/samples';
import { DONE_NOTIFY_MIN_TURN_MS, type StatusFacts } from '@shared/status';
import type { ClientPresence } from '../sync/ports';
import {
  EMPTY_FOCUS_HISTORY,
  chooseChannel,
  chooseChannelWithReason,
  decisionsCleared,
  isViewedByVisibleClient,
  isWatchedByFocusedClient,
  observeFocus,
  planNotification,
  presenceSummary,
  relayTarget,
  routeChannel,
  routeNotification,
  type ChannelReason,
  type FocusHistory,
  type PlannedNotification,
  type TieBreak,
} from './notifier';

const ENTRY: EntryId = sampleId('en', 1);
const OTHER: EntryId = sampleId('en', 2);
const NOW = new Date(SAMPLE_TIME);

function client(
  n: number,
  p: { focused: boolean; visible: boolean; viewing: EntryId | null; web?: boolean },
  lastFocusSec: number | null = n,
): ClientPresence {
  return {
    clientId: sampleId('cl', n),
    presence: {
      focused: p.focused,
      visible: p.visible,
      viewingEntryId: p.viewing,
      typing: false,
      ...(p.web === undefined ? {} : { systemNotifications: p.web }),
    },
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
            native: false,
            minDoneTurnMs: expected.min,
          },
    );
  });

  it('WP22-03/-15 with native toasts: no window → native only; a window without Web Notifications → native + in_app', () => {
    const native = (clientId: string | null, delivery: 'in_app' | 'system') => ({
      clientId,
      delivery,
      native: true,
      minDoneTurnMs: 0,
    });
    expect(chooseChannel([], ENTRY, true)).toEqual(native(null, 'system'));
    expect(chooseChannel([], ENTRY, false)).toBeNull();
    const blocked = [client(1, { focused: false, visible: false, viewing: null, web: false })];
    expect(chooseChannel(blocked, ENTRY, true)).toEqual(native(sampleId('cl', 1), 'in_app'));
    // Without native toasts the old rule: system (the window falls back to its in-app hint).
    expect(chooseChannel(blocked, ENTRY, false)).toMatchObject({ delivery: 'system', native: false });
    // A window that can (or an older client that does not say) → its Web Notification, no native toast.
    for (const web of [true, undefined]) {
      expect(
        chooseChannel([client(1, { focused: false, visible: false, viewing: null, web })], ENTRY, true),
      ).toMatchObject({ delivery: 'system', native: false });
    }
    // Looking at the window: in-app as always, never a native toast.
    const looking = [client(1, { focused: true, visible: true, viewing: OTHER, web: false })];
    expect(chooseChannel(looking, ENTRY, true)).toMatchObject({ delivery: 'in_app', native: false });
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
      native: false,
    });
    const elsewhere = [client(1, { focused: true, visible: true, viewing: OTHER })];
    expect(planNotification(working, shortDone, NOW, elsewhere, ENTRY)).toBeNull();
    // No window at all, native toasts on: a native toast only (clientId null).
    expect(planNotification(working, shortDone, NOW, [], ENTRY, true)).toEqual({
      clientId: null,
      kind: 'done',
      delivery: 'system',
      native: true,
    });
  });

  it('a new decision is reported with its kind (R0-13); cleared when the last one is gone', () => {
    const one = sampleStatusFacts({
      runState: 'working',
      decisions: {
        permission: 1,
        question: 0,
        plan: 0,
        elicitation: 0,
        oldestKind: 'permission',
        expired: 0,
      },
    });
    const two = sampleStatusFacts({
      runState: 'working',
      decisions: {
        permission: 1,
        question: 1,
        plan: 0,
        elicitation: 0,
        oldestKind: 'permission',
        expired: 0,
      },
    });
    const elsewhere = [client(1, { focused: true, visible: true, viewing: OTHER })];
    expect(planNotification(working, one, NOW, elsewhere, ENTRY)?.kind).toBe('permission');
    expect(planNotification(one, two, NOW, elsewhere, ENTRY)?.kind).toBe('question');
    expect(decisionsCleared(two, working)).toBe(true);
    expect(decisionsCleared(two, one)).toBe(false);
    expect(decisionsCleared(working, working)).toBe(false);
  });
});

// =====================================================================================
// ADR-109 (WP-31): the notification settings, one row per case
// =====================================================================================

describe('planNotification with settings.notifications (ADR-109)', () => {
  const working = sampleStatusFacts({ runState: 'working' });
  const transitions: Record<string, [StatusFacts, StatusFacts]> = {
    permission: [
      working,
      sampleStatusFacts({
        runState: 'working',
        decisions: {
          permission: 1,
          question: 0,
          plan: 0,
          elicitation: 0,
          oldestKind: 'permission',
          expired: 0,
        },
      }),
    ],
    doneShort: [
      working,
      sampleStatusFacts({
        unread: true,
        lastTurn: { outcome: 'success', endedAt: SAMPLE_TIME, durationMs: 5_000 },
      }),
    ],
    doneLong: [
      working,
      sampleStatusFacts({
        unread: true,
        lastTurn: { outcome: 'success', endedAt: SAMPLE_TIME, durationMs: 30_000 },
      }),
    ],
    error: [working, sampleStatusFacts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' })],
  };
  const clients: Record<string, ClientPresence[]> = {
    none: [],
    viewing: [client(1, { focused: true, visible: true, viewing: ENTRY })],
    elsewhere: [client(1, { focused: true, visible: true, viewing: OTHER })],
    elsewhereBlocked: [client(1, { focused: true, visible: true, viewing: OTHER, web: false })],
    away: [client(1, { focused: false, visible: false, viewing: null })],
    awayBlocked: [client(1, { focused: false, visible: false, viewing: null, web: false })],
    awayViewing: [client(1, { focused: false, visible: true, viewing: ENTRY })],
  };
  const quiet = (kind: keyof NotificationSettings['events']): Partial<NotificationSettings> => {
    const events = sampleNotificationSettings().events;
    return { events: { ...events, [kind]: { ...events[kind], toast: false } } };
  };
  const cl1 = sampleId('cl', 1);
  const to = (
    delivery: 'in_app' | 'system',
    kind: PlannedNotification['kind'] = 'permission',
    native = false,
    clientId: string | null = cl1,
  ): PlannedNotification => ({ clientId, kind, delivery, native });

  it.each<[string, Partial<NotificationSettings>, string, string, boolean, PlannedNotification | null]>([
    // name, settings, clients, transition, nativeAvailable, expected
    ['defaults: focused window elsewhere → in_app there', {}, 'elsewhere', 'permission', false, to('in_app')],
    ['defaults: background window → system', {}, 'away', 'permission', false, to('system')],
    ['defaults: the focused window shows the entry → nothing', {}, 'viewing', 'permission', true, null],
    ['defaults: visible but unfocused viewer → system', {}, 'awayViewing', 'permission', false, to('system')],
    [
      'defaults: no client + native → native only',
      {},
      'none',
      'permission',
      true,
      to('system', 'permission', true, null),
    ],
    ['defaults: no client, no native → nothing', {}, 'none', 'permission', false, null],
    [
      'defaults: blocked window + native → native + in_app',
      {},
      'awayBlocked',
      'permission',
      true,
      to('in_app', 'permission', true),
    ],
    [
      'DND: background window → in_app instead of system',
      { doNotDisturb: true },
      'away',
      'permission',
      false,
      to('in_app'),
    ],
    ['DND: no client + native → nothing', { doNotDisturb: true }, 'none', 'permission', true, null],
    [
      'DND: blocked window + native → in_app only (no native)',
      { doNotDisturb: true },
      'awayBlocked',
      'permission',
      true,
      to('in_app'),
    ],
    [
      'DND: focused window elsewhere → in_app as before',
      { doNotDisturb: true },
      'elsewhere',
      'permission',
      false,
      to('in_app'),
    ],
    [
      'DND: the window shows the entry → nothing',
      { doNotDisturb: true },
      'viewing',
      'permission',
      false,
      null,
    ],
    ['toast off for permission → in_app', quiet('permission'), 'away', 'permission', false, to('in_app')],
    [
      'toast off for permission → no native without client',
      quiet('permission'),
      'none',
      'permission',
      true,
      null,
    ],
    [
      'toast off for done does not touch permission',
      quiet('done'),
      'away',
      'permission',
      false,
      to('system'),
    ],
    ['toast off for error → in_app error', quiet('error'), 'away', 'error', true, to('in_app', 'error')],
    [
      'focusedElsewhere system: focused window elsewhere → system',
      { focusedElsewhere: 'system' },
      'elsewhere',
      'permission',
      false,
      to('system'),
    ],
    [
      'focusedElsewhere system + blocked + native → native + in_app',
      { focusedElsewhere: 'system' },
      'elsewhereBlocked',
      'permission',
      true,
      to('in_app', 'permission', true),
    ],
    [
      'focusedElsewhere system + blocked, no native → system',
      { focusedElsewhere: 'system' },
      'elsewhereBlocked',
      'permission',
      false,
      to('system'),
    ],
    [
      'focusedElsewhere system + DND → in_app',
      { focusedElsewhere: 'system', doNotDisturb: true },
      'elsewhere',
      'permission',
      false,
      to('in_app'),
    ],
    [
      'focusedElsewhere system: the window shows the entry → nothing',
      { focusedElsewhere: 'system' },
      'viewing',
      'permission',
      false,
      null,
    ],
    [
      'doneMinSeconds 20: short turn, focused elsewhere → nothing',
      { doneMinSeconds: 20 },
      'elsewhere',
      'doneShort',
      false,
      null,
    ],
    [
      'doneMinSeconds 20: long turn, focused elsewhere → in_app done',
      { doneMinSeconds: 20 },
      'elsewhere',
      'doneLong',
      false,
      to('in_app', 'done'),
    ],
    [
      'doneMinSeconds 0: short turn, focused elsewhere → in_app done',
      { doneMinSeconds: 0 },
      'elsewhere',
      'doneShort',
      false,
      to('in_app', 'done'),
    ],
    [
      'doneMinSeconds 60: 30-s turn, focused elsewhere → nothing',
      { doneMinSeconds: 60 },
      'elsewhere',
      'doneLong',
      false,
      null,
    ],
    [
      'doneMinSeconds 60: unfocused → every done (threshold 0)',
      { doneMinSeconds: 60 },
      'away',
      'doneShort',
      false,
      to('system', 'done'),
    ],
    [
      'focusedElsewhere system: focused threshold still applies',
      { focusedElsewhere: 'system', doneMinSeconds: 20 },
      'elsewhere',
      'doneShort',
      false,
      null,
    ],
    [
      'focusedElsewhere system: long turn → system done',
      { focusedElsewhere: 'system', doneMinSeconds: 20 },
      'elsewhere',
      'doneLong',
      false,
      to('system', 'done'),
    ],
    [
      'toast off for done + DND off: long turn → in_app done',
      quiet('done'),
      'away',
      'doneLong',
      true,
      to('in_app', 'done'),
    ],
  ])('%s', (_name, settings, clientKey, transitionKey, nativeAvailable, expected) => {
    const transition = transitions[transitionKey];
    const list = clients[clientKey];
    if (transition === undefined || list === undefined) throw new Error('bad table row');
    const [prev, next] = transition;
    const notifications = sampleNotificationSettings(settings);
    expect(planNotification(prev, next, NOW, list, ENTRY, nativeAvailable, notifications)).toEqual(expected);
  });

  it('isWatchedByFocusedClient needs focused + visible + viewing', () => {
    expect(isWatchedByFocusedClient(clients.viewing ?? [], ENTRY)).toBe(true);
    expect(isWatchedByFocusedClient(clients.awayViewing ?? [], ENTRY)).toBe(false);
    expect(isWatchedByFocusedClient(clients.elsewhere ?? [], ENTRY)).toBe(false);
    expect(isWatchedByFocusedClient([], ENTRY)).toBe(false);
  });
});

// =====================================================================================
// WP41-04: why the channel went where it went (debug log of the engine)
// =====================================================================================

describe('chooseChannelWithReason (WP41-04, ADR-129)', () => {
  it.each<[string, ClientPresence[], boolean, number | null, ChannelReason, TieBreak | null]>([
    // name, clients, nativeAvailable, target client (null = none), reason, tie-break stage
    [
      'focused window shows the entry',
      [client(1, { focused: true, visible: true, viewing: ENTRY })],
      true,
      null,
      'viewing_focused',
      null,
    ],
    [
      'another focused window',
      [
        client(1, { focused: true, visible: true, viewing: OTHER }, 3),
        client(2, { focused: false, visible: true, viewing: ENTRY }, 9),
      ],
      false,
      1,
      'focused_elsewhere',
      null,
    ],
    [
      'background windows → the most recently focused',
      [
        client(1, { focused: false, visible: true, viewing: ENTRY }, 5),
        client(2, { focused: false, visible: false, viewing: null }, 9),
      ],
      false,
      2,
      'last_focused',
      null,
    ],
    [
      'focused once, the others never → the focused one (even hidden, connected first, no Web Notifications)',
      [
        client(1, { focused: false, visible: false, viewing: null, web: false }, 5),
        client(2, { focused: false, visible: true, viewing: null }, null),
      ],
      false,
      1,
      'last_focused',
      null,
    ],
    [
      'same focus time, all alike → the most recently connected',
      [
        client(1, { focused: false, visible: false, viewing: null }, 5),
        client(2, { focused: false, visible: false, viewing: null }, 5),
        client(3, { focused: false, visible: false, viewing: null }, 1),
      ],
      false,
      2,
      'focus_tie',
      'connected',
    ],
    [
      'same focus time → the visible one (b equal, c decides)',
      [
        client(1, { focused: false, visible: true, viewing: null }, 5),
        client(2, { focused: false, visible: false, viewing: null }, 5),
      ],
      false,
      1,
      'focus_tie',
      'visible',
    ],
    [
      'never focused, all alike → the most recently connected',
      [
        client(1, { focused: false, visible: false, viewing: null }, null),
        client(2, { focused: false, visible: false, viewing: null }, null),
      ],
      false,
      2,
      'never_focused',
      'connected',
    ],
    [
      'never focused → Web Notifications possible before visible (b decides)',
      [
        client(1, { focused: false, visible: true, viewing: null, web: false }, null),
        client(2, { focused: false, visible: false, viewing: null, web: true }, null),
        client(3, { focused: false, visible: true, viewing: null, web: false }, null),
      ],
      false,
      2,
      'never_focused',
      'notifications',
    ],
    [
      'never focused → b keeps two, c decides',
      [
        client(1, { focused: false, visible: true, viewing: null }, null),
        client(2, { focused: false, visible: false, viewing: null }, null),
        client(3, { focused: false, visible: true, viewing: null, web: false }, null),
      ],
      false,
      1,
      'never_focused',
      'visible',
    ],
    [
      'never focused → b and c keep two, the most recently connected of them',
      [
        client(1, { focused: false, visible: true, viewing: null }, null),
        client(2, { focused: false, visible: true, viewing: null }, null),
        client(3, { focused: false, visible: false, viewing: null }, null),
      ],
      false,
      2,
      'never_focused',
      'connected',
    ],
    [
      'never focused, none can show Web Notifications → b does not separate, c decides',
      [
        client(1, { focused: false, visible: true, viewing: null, web: false }, null),
        client(2, { focused: false, visible: false, viewing: null, web: false }, null),
      ],
      false,
      1,
      'never_focused',
      'visible',
    ],
    [
      'a single never focused client',
      [client(1, { focused: false, visible: true, viewing: null }, null)],
      false,
      1,
      'never_focused',
      null,
    ],
    [
      'focused_elsewhere unchanged: several focused windows → the most recently focused, not by Web Notifications',
      [
        client(1, { focused: true, visible: true, viewing: OTHER, web: true }, 3),
        client(2, { focused: true, visible: true, viewing: null, web: false }, 7),
      ],
      false,
      2,
      'focused_elsewhere',
      null,
    ],
    ['no client + native toasts', [], true, null, 'no_client_native', null],
    ['no client, no native toasts', [], false, null, 'no_client', null],
  ])('%s', (_name, list, nativeAvailable, target, reason, tieBreak) => {
    const choice = chooseChannelWithReason(list, ENTRY, nativeAvailable);
    expect(choice.reason).toBe(reason);
    expect(choice.tieBreak).toBe(tieBreak);
    expect(choice.channel?.clientId ?? null).toBe(target === null ? null : sampleId('cl', target));
    // The channel itself is exactly chooseChannel's.
    expect(choice.channel).toEqual(chooseChannel(list, ENTRY, nativeAvailable));
  });

  it('WP-41 A4 (ADR-129): a never focused, visible app window wins against hidden helper clients that connected later', () => {
    // App window (visible, unfocused since its connection) + two hidden helper clients (px/watch).
    const app = client(1, { focused: false, visible: true, viewing: null }, null);
    const px = client(2, { focused: false, visible: false, viewing: null }, null);
    const watch = client(3, { focused: false, visible: false, viewing: null }, null);
    expect(chooseChannelWithReason([app, px, watch], ENTRY)).toMatchObject({
      reason: 'never_focused',
      tieBreak: 'visible',
      channel: { clientId: sampleId('cl', 1), delivery: 'system' },
    });
    // A focused helper still wins by its focus time (stage a).
    const focusedHelper = { ...watch, lastFocusAt: new Date(Date.parse(SAMPLE_TIME) + 60_000) };
    expect(chooseChannelWithReason([app, px, focusedHelper], ENTRY)).toMatchObject({
      reason: 'last_focused',
      tieBreak: null,
      channel: { clientId: sampleId('cl', 3) },
    });
  });

  it('minDoneTurnMs: focused threshold for a focused window (also when nothing is delivered), 0 otherwise', () => {
    const rules = { focusedElsewhere: 'in_app' as const, focusedDoneMinMs: 20_000 };
    const viewing = [client(1, { focused: true, visible: true, viewing: ENTRY })];
    const elsewhere = [client(1, { focused: true, visible: true, viewing: OTHER })];
    const away = [client(1, { focused: false, visible: false, viewing: null })];
    expect(chooseChannelWithReason(viewing, ENTRY, false, rules).minDoneTurnMs).toBe(20_000);
    expect(chooseChannelWithReason(elsewhere, ENTRY, false, rules).minDoneTurnMs).toBe(20_000);
    expect(chooseChannelWithReason(away, ENTRY, false, rules).minDoneTurnMs).toBe(0);
    expect(chooseChannelWithReason([], ENTRY, false, rules).minDoneTurnMs).toBe(0);
  });
});

describe('routeNotification (WP41-04)', () => {
  const working = sampleStatusFacts({ runState: 'working' });
  const permission = sampleStatusFacts({
    runState: 'working',
    decisions: { permission: 1, question: 0, plan: 0, elicitation: 0, oldestKind: 'permission', expired: 0 },
  });
  const shortDone = sampleStatusFacts({
    runState: 'idle',
    unread: true,
    lastTurn: { outcome: 'success', endedAt: SAMPLE_TIME, durationMs: 1_000 },
  });
  const away = [client(1, { focused: false, visible: false, viewing: null })];
  const awayBlocked = [client(1, { focused: false, visible: false, viewing: null, web: false })];
  const viewing = [client(1, { focused: true, visible: true, viewing: ENTRY })];
  const elsewhere = [client(1, { focused: true, visible: true, viewing: OTHER })];
  const cl1 = sampleId('cl', 1);

  it('no event → null (nothing to log)', () => {
    expect(routeNotification(working, working, NOW, away, ENTRY)).toBeNull();
    // A short "done" in a focused window elsewhere is below the threshold: no event either.
    expect(routeNotification(working, shortDone, NOW, elsewhere, ENTRY)).toBeNull();
  });

  it('delivered: kind, planned (= planNotification), reason, no filter', () => {
    const route = routeNotification(working, permission, NOW, away, ENTRY);
    expect(route).toEqual({
      kind: 'permission',
      planned: { clientId: cl1, kind: 'permission', delivery: 'system', native: false },
      reason: 'last_focused',
      tieBreak: null,
      filter: null,
    });
    expect(route?.planned).toEqual(planNotification(working, permission, NOW, away, ENTRY));
  });

  it('nothing delivered: the event is still reported with its reason', () => {
    expect(routeNotification(working, permission, NOW, viewing, ENTRY)).toEqual({
      kind: 'permission',
      planned: null,
      reason: 'viewing_focused',
      tieBreak: null,
      filter: null,
    });
    expect(routeNotification(working, shortDone, NOW, [], ENTRY, false)).toEqual({
      kind: 'done',
      planned: null,
      reason: 'no_client',
      tieBreak: null,
      filter: null,
    });
  });

  it('names the tie-break stage of the target (ADR-129)', () => {
    const tied = [
      client(1, { focused: false, visible: true, viewing: null }, null),
      client(2, { focused: false, visible: false, viewing: null }, null),
    ];
    expect(routeNotification(working, permission, NOW, tied, ENTRY)).toEqual({
      kind: 'permission',
      planned: { clientId: cl1, kind: 'permission', delivery: 'system', native: false },
      reason: 'never_focused',
      tieBreak: 'visible',
      filter: null,
    });
  });

  it('settings filter: DND and toast off are named; without a window the filter leaves nothing', () => {
    const dnd = sampleNotificationSettings({ doNotDisturb: true });
    expect(routeNotification(working, permission, NOW, away, ENTRY, true, dnd)).toEqual({
      kind: 'permission',
      planned: { clientId: cl1, kind: 'permission', delivery: 'in_app', native: false },
      reason: 'last_focused',
      tieBreak: null,
      filter: 'do_not_disturb',
    });
    const events = sampleNotificationSettings().events;
    const quiet = sampleNotificationSettings({
      events: { ...events, permission: { ...events.permission, toast: false } },
    });
    expect(routeNotification(working, permission, NOW, [], ENTRY, true, quiet)).toEqual({
      kind: 'permission',
      planned: null,
      reason: 'no_client_native',
      tieBreak: null,
      filter: 'toast_off',
    });
  });

  it('routeChannel names in-app, system, native, native + in-app and nothing', () => {
    const plan = (o: Partial<PlannedNotification>): PlannedNotification => ({
      clientId: cl1,
      kind: 'permission',
      delivery: 'system',
      native: false,
      ...o,
    });
    expect(routeChannel(null)).toBe('none');
    expect(routeChannel(plan({ delivery: 'in_app' }))).toBe('in_app');
    expect(routeChannel(plan({}))).toBe('system');
    expect(routeChannel(plan({ clientId: null, native: true }))).toBe('native');
    expect(routeChannel(plan({ delivery: 'in_app', native: true }))).toBe('native_in_app');
    expect(
      routeChannel(routeNotification(working, permission, NOW, awayBlocked, ENTRY, true)?.planned ?? null),
    ).toBe('native_in_app');
  });
});

describe('presenceSummary (WP41-04)', () => {
  it('per client: focus, visibility, Web Notifications, viewing, ever focused, connection rank', () => {
    const list = [
      client(1, { focused: false, visible: true, viewing: ENTRY, web: true }, 4),
      client(3, { focused: false, visible: false, viewing: OTHER, web: false }, null),
      client(2, { focused: true, visible: true, viewing: null }),
    ];
    expect(presenceSummary(list, ENTRY)).toEqual({
      count: 3,
      clients: [
        {
          clientId: sampleId('cl', 1),
          focused: false,
          visible: true,
          systemNotifications: true,
          viewing: true,
          everFocused: true,
          connectedRank: 3,
          remote: false,
        },
        {
          clientId: sampleId('cl', 3),
          focused: false,
          visible: false,
          systemNotifications: false,
          viewing: false,
          everFocused: false,
          connectedRank: 1,
          remote: false,
        },
        {
          clientId: sampleId('cl', 2),
          focused: true,
          visible: true,
          systemNotifications: null,
          viewing: false,
          everFocused: true,
          connectedRank: 2,
          remote: false,
        },
      ],
      relay: false,
    });
    expect(presenceSummary([], ENTRY)).toEqual({ count: 0, clients: [], relay: false });
  });
});

// =====================================================================================
// WP-81 (ADR-211): the watcher of the controlling computer
// =====================================================================================

const at = (sec: number): Date => new Date(Date.parse(SAMPLE_TIME) + sec * 1000);

/** A window of the controlling computer (through remote access). */
function remote(
  n: number,
  p: { focused: boolean; visible: boolean; viewing: EntryId | null; web?: boolean },
  lastFocusSec: number | null = n,
): ClientPresence {
  return { ...client(n, p, lastFocusSec), origin: 'remote', kind: 'window' };
}

/** The watcher: never focused, never visible (link.ts hello), connected at `connectedSec`. */
function relay(n = 50, connectedSec = 0): ClientPresence {
  return {
    clientId: sampleId('cl', n),
    presence: { focused: false, visible: false, viewingEntryId: null, typing: false },
    lastFocusAt: null,
    connectedAt: at(connectedSec),
    origin: 'remote',
    kind: 'relay',
  };
}

const RELAY = sampleId('cl', 50);

function history(clients: readonly ClientPresence[]): FocusHistory {
  return observeFocus(EMPTY_FOCUS_HISTORY, clients);
}

type RelayTargetRow = 'remote_focus' | 'no_local_focus' | null;

describe('the watcher is never part of the window logic (WP-81)', () => {
  it('ignored by the channel, the tie-break, "viewing" and the presence summary', () => {
    // Even a watcher that claims focus and the entry changes nothing.
    const claiming: ClientPresence = {
      ...relay(),
      presence: { focused: true, visible: true, viewingEntryId: ENTRY, typing: false },
      lastFocusAt: at(99),
    };
    expect(chooseChannelWithReason([claiming], ENTRY)).toMatchObject({ channel: null, reason: 'no_client' });
    expect(chooseChannelWithReason([claiming], ENTRY, true)).toMatchObject({
      channel: { clientId: null, native: true },
      reason: 'no_client_native',
    });
    const window = client(1, { focused: false, visible: false, viewing: null }, null);
    expect(chooseChannelWithReason([window, claiming], ENTRY)).toMatchObject({
      channel: { clientId: sampleId('cl', 1), delivery: 'system' },
      reason: 'never_focused',
      tieBreak: null,
    });
    expect(isViewedByVisibleClient([claiming], ENTRY)).toBe(false);
    expect(isWatchedByFocusedClient([claiming], ENTRY)).toBe(false);
    const summary = presenceSummary(
      [window, claiming, remote(2, { focused: true, visible: true, viewing: null })],
      ENTRY,
    );
    expect(summary.count).toBe(2);
    expect(summary.relay).toBe(true);
    expect(summary.clients.map((c) => [c.clientId, c.remote])).toEqual([
      [sampleId('cl', 1), false],
      [sampleId('cl', 2), true],
    ]);
  });
});

describe('observeFocus (WP-81)', () => {
  it('keeps the latest focus per origin, also of windows that are gone', () => {
    let h = history([
      client(1, { focused: false, visible: true, viewing: null }, 5),
      remote(2, { focused: false, visible: true, viewing: null }, 3),
    ]);
    expect(h).toEqual({ local: at(5), remote: at(3), relay: null });
    // The windows closed: presence is empty, the history stays.
    expect(observeFocus(h, [])).toBe(h);
    h = observeFocus(h, [remote(3, { focused: true, visible: true, viewing: null }, 8)]);
    expect(h).toMatchObject({ local: at(5), remote: at(8) });
    // An older focus (a window that came back with its remembered focus) changes nothing.
    expect(observeFocus(h, [client(4, { focused: false, visible: true, viewing: null }, 2)])).toBe(h);
  });

  it('the watcher counts from its first connection in this server run (same client id)', () => {
    let h = history([relay(50, 10)]);
    expect(h.relay).toEqual({ clientId: RELAY, since: at(10) });
    // Reconnect of the same watcher: the first time stays.
    h = observeFocus(h, [relay(50, 40)]);
    expect(h.relay).toEqual({ clientId: RELAY, since: at(10) });
    // A new watcher (the controlling server restarted): its own time.
    h = observeFocus(h, [relay(51, 60)]);
    expect(h.relay).toEqual({ clientId: sampleId('cl', 51), since: at(60) });
  });
});

describe('relayTarget (WP-81, ADR-211)', () => {
  const idle = { focused: false, visible: true, viewing: null };
  it.each<[string, ClientPresence[], FocusHistory | null, RelayTargetRow]>([
    ['no watcher → null', [client(1, idle, 1)], null, null],
    ['watcher, no window ever focused → the watcher', [relay(50, 0)], null, 'no_local_focus'],
    [
      'the last focused window came through remote access → the watcher',
      [client(1, idle, 5), remote(2, idle, 9), relay(50, 0)],
      null,
      'remote_focus',
    ],
    [
      'the last focused window is local and was focused after the watcher connected → null',
      [client(1, idle, 9), remote(2, idle, 5), relay(50, 0)],
      null,
      null,
    ],
    [
      'same focus time: this computer wins',
      [client(1, idle, 5), remote(2, idle, 5), relay(50, 0)],
      null,
      null,
    ],
    [
      'no local window focused since the watcher connected → the watcher',
      [client(1, idle, 5), relay(50, 20)],
      null,
      'no_local_focus',
    ],
    [
      'the remote window is closed, it was still the last one focused → the watcher',
      [client(1, idle, 5), relay(50, 0)],
      { local: at(5), remote: at(9), relay: { clientId: RELAY, since: at(0) } },
      'remote_focus',
    ],
    [
      'a reconnect of the watcher does not count as "connected since"',
      [client(1, idle, 5), relay(50, 30)],
      { local: at(5), remote: null, relay: { clientId: RELAY, since: at(0) } },
      null,
    ],
  ])('%s', (_name, clients, given, expected) => {
    const h = given ?? history(clients);
    expect(relayTarget(clients, h)).toEqual(expected === null ? null : { clientId: RELAY, reason: expected });
  });
});

describe('routeNotification with the watcher (WP-81, ADR-211)', () => {
  const working = sampleStatusFacts({ runState: 'working' });
  const permission = sampleStatusFacts({
    runState: 'working',
    decisions: { permission: 1, question: 0, plan: 0, elicitation: 0, oldestKind: 'permission', expired: 0 },
  });
  const cl1 = sampleId('cl', 1);
  const blockedRemote = remote(1, { focused: false, visible: false, viewing: null, web: false }, 5);
  const route = (clients: ClientPresence[], nativeAvailable: boolean, settings?: NotificationSettings) =>
    routeNotification(working, permission, NOW, clients, ENTRY, nativeAvailable, settings, history(clients));

  it('no window at all: the watcher gets it – also when this computer cannot toast', () => {
    for (const nativeAvailable of [true, false]) {
      expect(route([relay()], nativeAvailable)).toEqual({
        kind: 'permission',
        planned: {
          clientId: null,
          kind: 'permission',
          delivery: 'system',
          native: false,
          relayClientId: RELAY,
        },
        reason: 'no_client_native',
        tieBreak: null,
        filter: null,
        relay: 'no_local_focus',
      });
    }
  });

  it('a remote window without Web Notifications keeps its in-app hint; the watcher gets the toast', () => {
    const r = route([blockedRemote, relay()], true);
    expect(r?.planned).toEqual({
      clientId: cl1,
      kind: 'permission',
      delivery: 'in_app',
      native: false,
      relayClientId: RELAY,
    });
    expect(r?.relay).toBe('remote_focus');
    expect(routeChannel(r?.planned ?? null)).toBe('relay_in_app');
  });

  it('a window that can show Web Notifications gets them; no toast anywhere', () => {
    const able = remote(1, { focused: false, visible: false, viewing: null, web: true }, 5);
    const r = route([able, relay()], true);
    expect(r?.planned).toEqual({ clientId: cl1, kind: 'permission', delivery: 'system', native: false });
    expect(r?.relay).toBeUndefined();
  });

  it('the user was last at this computer: the local toast as before', () => {
    const local = client(1, { focused: false, visible: false, viewing: null, web: false }, 5);
    const r = route([local, relay(50, 0)], true);
    expect(r?.planned).toEqual({ clientId: cl1, kind: 'permission', delivery: 'in_app', native: true });
    expect(r?.relay).toBeUndefined();
    // Without native toasts here: the old rule (system to the window), never the watcher.
    expect(route([local, relay(50, 0)], false)?.planned).toEqual({
      clientId: cl1,
      kind: 'permission',
      delivery: 'system',
      native: false,
    });
  });

  it('the settings filter of this computer still applies first: nothing for the watcher', () => {
    const dnd = sampleNotificationSettings({ doNotDisturb: true });
    expect(route([relay()], true, dnd)).toMatchObject({ planned: null, filter: 'do_not_disturb' });
    expect(route([blockedRemote, relay()], true, dnd)?.planned).toEqual({
      clientId: cl1,
      kind: 'permission',
      delivery: 'in_app',
      native: false,
    });
  });

  it('without a focus history (older callers) the watcher is never chosen', () => {
    expect(routeNotification(working, permission, NOW, [relay()], ENTRY, true)?.planned).toEqual({
      clientId: null,
      kind: 'permission',
      delivery: 'system',
      native: true,
    });
    expect(
      planNotification(working, permission, NOW, [relay()], ENTRY, true, undefined, history([relay()])),
    ).toEqual({
      clientId: null,
      kind: 'permission',
      delivery: 'system',
      native: false,
      relayClientId: RELAY,
    });
  });

  it('routeChannel: the watcher alone, or with the in-app hint', () => {
    const plan: PlannedNotification = {
      clientId: null,
      kind: 'done',
      delivery: 'system',
      native: false,
      relayClientId: RELAY,
    };
    expect(routeChannel(plan)).toBe('relay');
    expect(routeChannel({ ...plan, clientId: cl1, delivery: 'in_app' })).toBe('relay_in_app');
  });
});
