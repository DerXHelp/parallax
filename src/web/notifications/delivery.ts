import type { NotificationKind } from '@shared/status';
import { t, type TranslationKey } from '@web/i18n';
import { dismissNotification, dismissSessionNotifications } from '@web/state/hooks';
import { dismissNotice, showNotice } from '@web/state/notices';
import { setSelectedSession } from '@web/state/selection';
import { clientStore, type ClientNotification, type ClientStore, type NoticeTone } from '@web/state/store';
import { chooseDeliveryChannel } from './channel';
import { getSystemNotifier, type SystemNotifier, type SystemToast } from './system';

/**
 * Delivers the server's `notify` messages of this window (A.9, Plan "Benachrichtigungen",
 * Phase-1 minimum): the connection keeps them in `ClientState.notifications` until `notify.clear`;
 * this module shows each one exactly once – an in-app hint over the notices API
 * (state/notices.ts, NotificationCenter region, "Show session") or a Web Notification (Windows
 * toast via Edge, `tag = sessionKey`, click → focus the window and show the session), chosen by
 * `chooseDeliveryChannel`. A `notify.clear` (decision answered elsewhere) retracts both; showing a
 * session clears its notifications (they are seen). Runs outside React (started by bootApp and
 * for the playground in main.tsx).
 */

/** In-app hints stay this long unless the user acts. */
export const IN_APP_NOTIFICATION_MS = 10_000;

const TONE: Readonly<Record<NotificationKind, NoticeTone>> = {
  permission: 'warning',
  question: 'warning',
  plan: 'warning',
  done: 'success',
  error: 'error',
  rate_limit: 'warning',
};

/** Notice id of a server notification (a repeated id replaces, never stacks). */
export function noticeIdOf(notificationId: string): string {
  return `notify:${notificationId}`;
}

function textKey(kind: NotificationKind): TranslationKey {
  return `shell.notifications.kinds.${kind}`;
}

export interface NotificationDeliveryOptions {
  store?: ClientStore;
  /** Default: the current system notifier (`getSystemNotifier`). */
  notifier?: SystemNotifier;
  /** Brings this window to the front on a toast click; default `window.focus()`. */
  focusWindow?: () => void;
}

interface Delivered {
  sessionKey: string;
  noticeId: string | null;
  toast: SystemToast | null;
}

/** Starts the delivery for one store; returns the stop function. */
export function startNotificationDelivery(options: NotificationDeliveryOptions = {}): () => void {
  const store = options.store ?? clientStore;
  const notifier = options.notifier ?? getSystemNotifier();
  const focusWindow =
    options.focusWindow ??
    (() => {
      window.focus();
    });
  const delivered = new Map<string, Delivered>();
  let selected = store.getState().selectedSession;
  let syncing = false;
  /** Counts sync requests; a request during a step makes the step run again. */
  let requests = 0;

  function deliver(notification: ClientNotification): void {
    const { presence } = store.getState();
    const params = { title: notification.title };
    const channel = chooseDeliveryChannel({
      focused: presence.focused,
      visible: presence.visible,
      permission: notifier.permission(),
    });
    if (channel === 'system') {
      const toast = notifier.show({
        title: t(textKey(notification.kind), params),
        body: t('shell.notifications.toastBody'),
        tag: notification.sessionKey,
        onClick: () => {
          focusWindow();
          setSelectedSession(notification.sessionKey, { store });
          dismissNotification(notification.id, store);
        },
      });
      if (toast !== null) {
        // The new toast replaced an older one with the same tag: never close that handle later.
        for (const entry of delivered.values()) {
          if (entry.sessionKey === notification.sessionKey) entry.toast = null;
        }
        delivered.set(notification.id, { sessionKey: notification.sessionKey, noticeId: null, toast });
        return;
      }
    }
    const noticeId = showNotice(
      { text: textKey(notification.kind), params },
      {
        id: noticeIdOf(notification.id),
        sessionKey: notification.sessionKey,
        tone: TONE[notification.kind],
        durationMs: IN_APP_NOTIFICATION_MS,
        store,
      },
    );
    delivered.set(notification.id, { sessionKey: notification.sessionKey, noticeId, toast: null });
  }

  function retract(id: string): void {
    const entry = delivered.get(id);
    if (entry === undefined) return;
    delivered.delete(id);
    if (entry.noticeId !== null) dismissNotice(entry.noticeId, store);
    entry.toast?.close();
  }

  function step(): void {
    const state = store.getState();
    if (state.selectedSession !== selected) {
      selected = state.selectedSession;
      const shown = selected;
      // The window shows the session now: its notifications are seen (re-enters via the store).
      if (shown !== null && state.notifications.some((n) => n.sessionKey === shown)) {
        dismissSessionNotifications(shown, store);
        return;
      }
    }
    const current = new Set(state.notifications.map((n) => n.id));
    for (const id of [...delivered.keys()]) if (!current.has(id)) retract(id);
    for (const notification of state.notifications) {
      if (!delivered.has(notification.id)) deliver(notification);
    }
  }

  /** Store updates from inside a step (dismissals) re-run it instead of nesting. */
  function sync(): void {
    requests++;
    if (syncing) return;
    syncing = true;
    try {
      let handled: number;
      do {
        handled = requests;
        step();
      } while (handled !== requests);
    } finally {
      syncing = false;
    }
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.notifications !== previous.notifications ||
      state.selectedSession !== previous.selectedSession
    ) {
      sync();
    }
  });
  sync();
  return () => {
    unsubscribe();
    delivered.clear();
  };
}
