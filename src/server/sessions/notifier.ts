/**
 * Notification channel (WP-13 §3.5.15, A.9, architecture §5 "Präsenz"; Phase 2 ADR-109), pure and
 * table-tested: at most one channel per event.
 *
 * Channel: a focused + visible window shows the entry → nothing; another focused + visible window →
 * `in_app` there (`settings.notifications.focusedElsewhere 'in_app'`, default) or `system` to that
 * window (`'system'`); otherwise `system` to the last focused client. "done" needs a turn of at least
 * `doneMinSeconds` when the target window is focused, any length otherwise. WP22-03/-15 (Plan A.9)
 * with native toasts available (`nativeAvailable`): a `system` target that cannot show Web
 * Notifications (presence `systemNotifications: false`) → a native Windows toast plus the in-app
 * hint in that window; no client at all → a native toast only. Without native toasts: as before
 * (nothing without a client). Which event: `notificationFor` (@shared/status).
 *
 * Settings filter (ADR-109): "Nicht stören" (`doNotDisturb`) or `events[kind].toast === false` → no
 * OS notification (neither `system` nor native): the chosen client gets the `in_app` hint instead,
 * without a client nothing. Sounds are the client's business (it applies `sound` + DND itself).
 */
import type { ClientId, EntryId } from '@shared/common';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@shared/model';
import type { Notification } from '@shared/protocol';
import {
  DONE_NOTIFY_MIN_TURN_MS,
  notificationFor,
  openDecisionCount,
  type NotificationKind,
  type StatusFacts,
} from '@shared/status';
import type { ClientPresence } from '../sync/ports';

export interface NotificationChannel {
  /** The window that gets the `notify` message; null = none (native toast only). */
  clientId: ClientId | null;
  delivery: Notification['delivery'];
  /** The server also shows a native Windows toast. */
  native: boolean;
  /** minDoneTurnMs for notificationFor. */
  minDoneTurnMs: number;
}

/** The parts of `settings.notifications` the channel choice needs. */
export interface ChannelRules {
  focusedElsewhere: NotificationSettings['focusedElsewhere'];
  /** "done" threshold for a focused target window (ms). */
  focusedDoneMinMs: number;
}

export const DEFAULT_CHANNEL_RULES: Readonly<ChannelRules> = Object.freeze({
  focusedElsewhere: 'in_app',
  focusedDoneMinMs: DONE_NOTIFY_MIN_TURN_MS,
});

function time(date: Date | null): number {
  return date === null ? Number.NEGATIVE_INFINITY : date.getTime();
}

/** Most recently focused client (ties and never focused: most recently connected). */
function lastFocused(clients: readonly ClientPresence[]): ClientPresence | null {
  let best: ClientPresence | null = null;
  for (const client of clients) {
    if (
      best === null ||
      time(client.lastFocusAt) > time(best.lastFocusAt) ||
      (time(client.lastFocusAt) === time(best.lastFocusAt) &&
        client.connectedAt.getTime() > best.connectedAt.getTime())
    ) {
      best = client;
    }
  }
  return best;
}

/** `system` to `target` – or native + in_app when it cannot show Web Notifications (WP22-03/-15). */
function systemChannel(
  target: ClientPresence,
  nativeAvailable: boolean,
  minDoneTurnMs: number,
): NotificationChannel {
  if (nativeAvailable && target.presence.systemNotifications === false) {
    return { clientId: target.clientId, delivery: 'in_app', native: true, minDoneTurnMs };
  }
  return { clientId: target.clientId, delivery: 'system', native: false, minDoneTurnMs };
}

export function chooseChannel(
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
  rules: ChannelRules = DEFAULT_CHANNEL_RULES,
): NotificationChannel | null {
  const active = clients.filter((c) => c.presence.focused && c.presence.visible);
  if (active.some((c) => c.presence.viewingEntryId === entryId)) return null;
  const window = lastFocused(active);
  if (window !== null) {
    if (rules.focusedElsewhere === 'system')
      return systemChannel(window, nativeAvailable, rules.focusedDoneMinMs);
    return {
      clientId: window.clientId,
      delivery: 'in_app',
      native: false,
      minDoneTurnMs: rules.focusedDoneMinMs,
    };
  }
  const target = lastFocused(clients);
  if (target === null) {
    return nativeAvailable ? { clientId: null, delivery: 'system', native: true, minDoneTurnMs: 0 } : null;
  }
  return systemChannel(target, nativeAvailable, 0);
}

/** A client shows this entry visibly (presence) → no unread (ReduceStatusContext). */
export function isViewedByVisibleClient(clients: readonly ClientPresence[], entryId: EntryId): boolean {
  return clients.some((c) => c.presence.visible && c.presence.viewingEntryId === entryId);
}

/** A focused + visible window shows this entry (ADR-105: such a session never falls asleep). */
export function isWatchedByFocusedClient(clients: readonly ClientPresence[], entryId: EntryId): boolean {
  return clients.some(
    (c) => c.presence.focused && c.presence.visible && c.presence.viewingEntryId === entryId,
  );
}

export interface PlannedNotification {
  /** null = no window (native toast only). */
  clientId: ClientId | null;
  kind: NotificationKind;
  delivery: Notification['delivery'];
  native: boolean;
}

/**
 * The notification a status transition triggers (channel + kind), or null. `notifications` =
 * `settings.notifications` (ADR-109; default: the defaults of the settings schema).
 */
export function planNotification(
  prev: StatusFacts,
  next: StatusFacts,
  now: Date,
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
  notifications: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
): PlannedNotification | null {
  const channel = chooseChannel(clients, entryId, nativeAvailable, {
    focusedElsewhere: notifications.focusedElsewhere,
    focusedDoneMinMs: notifications.doneMinSeconds * 1000,
  });
  if (channel === null) return null;
  const kind = notificationFor(prev, next, now, { minDoneTurnMs: channel.minDoneTurnMs });
  if (kind === null) return null;
  if (notifications.doNotDisturb || !notifications.events[kind].toast) {
    // No OS notification: the in-app hint in the chosen window only (none without a window).
    return channel.clientId === null
      ? null
      : { clientId: channel.clientId, kind, delivery: 'in_app', native: false };
  }
  return { clientId: channel.clientId, kind, delivery: channel.delivery, native: channel.native };
}

/** The last open decision is gone → clear the entry's notification (answered elsewhere). */
export function decisionsCleared(prev: StatusFacts, next: StatusFacts): boolean {
  return openDecisionCount(prev) > 0 && openDecisionCount(next) === 0;
}
