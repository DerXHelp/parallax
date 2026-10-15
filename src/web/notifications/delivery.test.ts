import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import { sampleId, sampleTime } from '@shared/samples';
import type { NotificationKind } from '@shared/status';
import { createClientStore, type ClientNotification, type ClientStore } from '@web/state/store';
import type { NotificationPermissionState } from './channel';
import { IN_APP_NOTIFICATION_MS, noticeIdOf, startNotificationDelivery } from './delivery';
import type { SystemNotifier, SystemToastOptions } from './system';

const ENTRY: EntryId = sampleId('en', 1);
const OTHER: EntryId = sampleId('en', 2);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
const OTHER_KEY = makeSessionKey(LOCAL_HOST_ID, OTHER);

interface FakeNotifier extends SystemNotifier {
  shown: (SystemToastOptions & { closed: boolean })[];
  grant(state: NotificationPermissionState): void;
}

function fakeNotifier(initial: NotificationPermissionState = 'granted'): FakeNotifier {
  let permission = initial;
  const shown: (SystemToastOptions & { closed: boolean })[] = [];
  return {
    shown,
    grant(state) {
      permission = state;
    },
    permission: () => permission,
    requestPermission: () => Promise.resolve(permission),
    show(options) {
      if (permission !== 'granted') return null;
      const entry = { ...options, closed: false };
      shown.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
  };
}

function notification(
  id: string,
  kind: NotificationKind,
  entryId: EntryId = ENTRY,
  delivery: ClientNotification['delivery'] = 'system',
): ClientNotification {
  return {
    id,
    kind,
    entryId,
    title: 'Auth service',
    delivery,
    at: sampleTime(),
    hostId: LOCAL_HOST_ID,
    sessionKey: makeSessionKey(LOCAL_HOST_ID, entryId),
  };
}

function push(store: ClientStore, ...items: ClientNotification[]): void {
  store.setState((state) => ({ notifications: [...state.notifications, ...items] }));
}

function setFocus(store: ClientStore, focused: boolean, visible = true): void {
  store.setState({ presence: { focused, visible, typing: false } });
}

let stop: (() => void) | null = null;
let store: ClientStore;

beforeEach(() => {
  store = createClientStore();
});

afterEach(() => {
  stop?.();
  stop = null;
  window.history.replaceState(null, '', '/');
});

describe('notification delivery (A.9, Phase-1 minimum)', () => {
  it('shows an in-app hint in the focused window (notices API, "Show session")', () => {
    const notifier = fakeNotifier('granted');
    stop = startNotificationDelivery({ store, notifier });
    setFocus(store, true);
    push(store, notification('n1', 'plan', ENTRY, 'in_app'));
    expect(notifier.shown).toHaveLength(0);
    expect(store.getState().notices).toEqual([
      {
        id: noticeIdOf('n1'),
        tone: 'warning',
        content: { text: 'shell.notifications.kinds.plan', params: { title: 'Auth service' } },
        sessionKey: KEY,
        durationMs: IN_APP_NOTIFICATION_MS,
      },
    ]);
  });

  it('shows a Web Notification (tag = sessionKey) when the window is not focused', () => {
    const notifier = fakeNotifier('granted');
    stop = startNotificationDelivery({ store, notifier });
    setFocus(store, false);
    push(store, notification('n1', 'permission'));
    expect(notifier.shown).toMatchObject([
      { title: 'Auth service – needs permission', body: 'Click to show the session.', tag: KEY },
    ]);
    expect(store.getState().notices).toHaveLength(0);
  });

  it('also follows the window when the server still thought it was focused (race)', () => {
    const notifier = fakeNotifier('granted');
    stop = startNotificationDelivery({ store, notifier });
    setFocus(store, false, false);
    push(store, notification('n1', 'done', ENTRY, 'in_app'));
    expect(notifier.shown).toHaveLength(1);
    setFocus(store, true);
    push(store, notification('n2', 'done', OTHER, 'system'));
    expect(notifier.shown).toHaveLength(1);
    expect(store.getState().notices.map((n) => n.id)).toEqual([noticeIdOf('n2')]);
  });

  it('falls back to the in-app hint without permission', () => {
    const notifier = fakeNotifier('default');
    stop = startNotificationDelivery({ store, notifier });
    setFocus(store, false);
    push(store, notification('n1', 'question'));
    expect(notifier.shown).toHaveLength(0);
    expect(store.getState().notices.map((n) => n.id)).toEqual([noticeIdOf('n1')]);
  });

  it('a toast click focuses the window and shows the session', () => {
    const notifier = fakeNotifier('granted');
    const focusWindow = vi.fn();
    stop = startNotificationDelivery({ store, notifier, focusWindow });
    setFocus(store, false);
    push(store, notification('n1', 'plan'));
    notifier.shown[0]?.onClick();
    expect(focusWindow).toHaveBeenCalledOnce();
    expect(store.getState().selectedSession).toBe(KEY);
    expect(window.location.hash).toBe(`#session=${KEY}`);
    expect(store.getState().notifications).toHaveLength(0);
  });

  it('delivers every notification once and retracts it on notify.clear', () => {
    const notifier = fakeNotifier('granted');
    stop = startNotificationDelivery({ store, notifier });
    setFocus(store, false);
    push(store, notification('n1', 'permission'));
    setFocus(store, true);
    push(store, notification('n2', 'question', OTHER));
    push(store, notification('n3', 'done', OTHER));
    expect(notifier.shown).toHaveLength(1);
    expect(store.getState().notices.map((n) => n.id)).toEqual([noticeIdOf('n2'), noticeIdOf('n3')]);
    // notify.clear (connection.ts drops the session's notifications): toast and hints go away.
    store.setState((state) => ({ notifications: state.notifications.filter((n) => n.sessionKey !== KEY) }));
    expect(notifier.shown[0]?.closed).toBe(true);
    store.setState({ notifications: [] });
    expect(store.getState().notices).toHaveLength(0);
  });

  it('showing a session clears its notifications (seen), others stay', () => {
    const notifier = fakeNotifier('default');
    stop = startNotificationDelivery({ store, notifier });
    push(store, notification('n1', 'permission'), notification('n2', 'done', OTHER));
    store.setState({ selectedSession: KEY });
    expect(store.getState().notifications.map((n) => n.id)).toEqual(['n2']);
    expect(store.getState().notices.map((n) => n.sessionKey)).toEqual([OTHER_KEY]);
  });

  it('does not close a toast that a newer toast of the same session replaced', () => {
    const notifier = fakeNotifier('granted');
    stop = startNotificationDelivery({ store, notifier });
    setFocus(store, false);
    push(store, notification('n1', 'permission'));
    push(store, notification('n2', 'question'));
    store.setState((state) => ({ notifications: state.notifications.filter((n) => n.id !== 'n1') }));
    expect(notifier.shown.map((toast) => toast.closed)).toEqual([false, false]);
  });
});
