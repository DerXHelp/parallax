import type { SoundId } from '@shared/model';
import type { NotificationKind } from '@shared/status';
import { t, type TranslationKey } from '@web/i18n';
import { sessionTitle } from '@web/lib/session-title';
import { dismissNotification, dismissSessionNotifications, selectSummary } from '@web/state/hooks';
import { dismissNotice, showNotice } from '@web/state/notices';
import { setSelectedSession } from '@web/state/selection';
import { selectSettings } from '@web/state/settings';
import { clientStore, type ClientNotification, type ClientStore, type NoticeTone } from '@web/state/store';
import { chooseDeliveryChannel } from './channel';
import { installAudioUnlock, webAudioPlayer, type SoundPlayer } from './sounds';
import { getSystemNotifier, type SystemNotifier, type SystemToast } from './system';

/**
 * Delivers the server's `notify` messages of this window (A.9, Plan "Benachrichtigungen",
 * ADR-109): the connection keeps them in `ClientState.notifications` until `notify.clear`; this
 * module shows each one exactly once – an in-app hint over the notices API (state/notices.ts,
 * NotificationCenter region, "Show session") or a Web Notification (Windows toast via Edge,
 * `tag = sessionKey`, click → focus the window and show the session), on the server's channel
 * (`chooseDeliveryChannel` only corrects a stale presence). The server already applied "Do not
 * disturb", the toast switches, the focus rule and the "done" threshold; the window adds the sound
 * (`events[kind].sound`, not "Do not disturb", Web Audio – sounds.ts) and makes its own Web
 * Notifications silent then. A sound locked by the autoplay policy shows the hint "Enable sounds"
 * with a button of that name once per window run (until the first interaction unlocks them). The
 * launcher's window allows audio without a gesture (ADR-120): its first sound unlocks at once
 * (WP41-01, sounds.ts), so the hint is the fallback for other windows. A `notify.clear` (decision
 * answered elsewhere) retracts hint and toast; showing a session clears its notifications (they
 * are seen). Runs outside React (started by bootApp and for the playground in main.tsx).
 */

/** In-app hints stay this long unless the user acts. */
export const IN_APP_NOTIFICATION_MS = 10_000;

/** Notice id of the hint "sounds are locked until you interact with the window". */
export const SOUNDS_LOCKED_NOTICE_ID = 'notifications:sounds-locked';

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
  /**
   * Notification sounds; default Web Audio (`webAudioPlayer`), unlocked by the first
   * pointerdown/keydown in this window (`installAudioUnlock`). Tests inject a fake.
   */
  sounds?: SoundPlayer;
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
  const sounds = options.sounds ?? webAudioPlayer;
  const removeUnlock = options.sounds === undefined ? installAudioUnlock(window) : null;
  const delivered = new Map<string, Delivered>();
  let selected = store.getState().selectedSession;
  let syncing = false;
  /** Counts sync requests; a request during a step makes the step run again. */
  let requests = 0;
  let stopped = false;
  /** "Enable sounds" was shown in this window run (once is enough). */
  let lockedHintShown = false;
  let removeUnlockListener: (() => void) | null = null;

  function showLockedHint(): void {
    if (stopped || lockedHintShown) return;
    lockedHintShown = true;
    showNotice(
      { text: 'preferences.sounds.locked' },
      {
        id: SOUNDS_LOCKED_NOTICE_ID,
        tone: 'info',
        durationMs: null,
        store,
        // ADR-126: a button to click (any click or key in the window unlocks as well).
        action: {
          label: 'navigation.notices.enableSounds',
          run: () => {
            sounds.unlock?.();
          },
        },
      },
    );
    // The first interaction unlocks the sounds (installAudioUnlock): the hint has done its job.
    const hide = () => {
      removeUnlockListener?.();
      removeUnlockListener = null;
      dismissNotice(SOUNDS_LOCKED_NOTICE_ID, store);
    };
    removeUnlockListener = sounds.onUnlock(hide);
    if (sounds.state() === 'ready') hide();
  }

  function ring(soundId: SoundId, volume: number): void {
    sounds.play(soundId, volume).then(
      (result) => {
        if (result === 'locked') showLockedHint();
      },
      () => undefined,
    );
  }

  function deliver(notification: ClientNotification): void {
    const state = store.getState();
    const { presence } = state;
    const settings = selectSettings(state, notification.hostId).notifications;
    const event = settings.events[notification.kind];
    const withSound = event.sound && !settings.doNotDisturb;
    // A session without a title yet (created without a prompt) is named by its folder (V2-05).
    const summary = notification.title.trim() === '' ? selectSummary(state, notification.sessionKey) : null;
    const params = { title: summary === null ? notification.title : sessionTitle(summary) };
    const channel = chooseDeliveryChannel({
      delivery: notification.delivery,
      focused: presence.focused,
      visible: presence.visible,
      permission: notifier.permission(),
      focusedElsewhere: settings.focusedElsewhere,
      osAllowed: event.toast && !settings.doNotDisturb,
    });
    if (withSound) ring(event.soundId, settings.volume);
    if (channel === 'system') {
      const toast = notifier.show({
        title: t(textKey(notification.kind), params),
        body: t('shell.notifications.toastBody'),
        tag: notification.sessionKey,
        // Silent when the window plays the sound itself or the event has none; a locked or
        // missing Web Audio leaves the sound to the browser.
        silent: !withSound || sounds.state() === 'ready',
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
    stopped = true;
    unsubscribe();
    removeUnlock?.();
    removeUnlockListener?.();
    removeUnlockListener = null;
    delivered.clear();
  };
}
