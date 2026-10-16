/**
 * Notification channel (WP-13 §3.5.15, A.9, architecture §5 "Präsenz"), pure and table-tested:
 * exactly one channel per event. A focused + visible window shows the entry → nothing; another
 * focused + visible window → `in_app` there (done only for turns ≥ DONE_NOTIFY_MIN_TURN_MS);
 * otherwise `system` to the last focused client (every done). WP22-03/-15 (Plan A.9) with native
 * toasts available (`nativeAvailable`): that client cannot show Web Notifications (presence
 * `systemNotifications: false`) → a native Windows toast plus the in-app hint in that window;
 * no client at all → a native toast only. Without native toasts: as before (nothing without a
 * client). Which event: `notificationFor` (@shared/status).
 */
import type { ClientId, EntryId } from '@shared/common';
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

export function chooseChannel(
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
): NotificationChannel | null {
  const active = clients.filter((c) => c.presence.focused && c.presence.visible);
  if (active.some((c) => c.presence.viewingEntryId === entryId)) return null;
  const window = lastFocused(active);
  if (window !== null) {
    return {
      clientId: window.clientId,
      delivery: 'in_app',
      native: false,
      minDoneTurnMs: DONE_NOTIFY_MIN_TURN_MS,
    };
  }
  const target = lastFocused(clients);
  if (target === null) {
    return nativeAvailable ? { clientId: null, delivery: 'system', native: true, minDoneTurnMs: 0 } : null;
  }
  if (nativeAvailable && target.presence.systemNotifications === false) {
    return { clientId: target.clientId, delivery: 'in_app', native: true, minDoneTurnMs: 0 };
  }
  return { clientId: target.clientId, delivery: 'system', native: false, minDoneTurnMs: 0 };
}

/** A client shows this entry visibly (presence) → no unread (ReduceStatusContext). */
export function isViewedByVisibleClient(clients: readonly ClientPresence[], entryId: EntryId): boolean {
  return clients.some((c) => c.presence.visible && c.presence.viewingEntryId === entryId);
}

export interface PlannedNotification {
  /** null = no window (native toast only). */
  clientId: ClientId | null;
  kind: NotificationKind;
  delivery: Notification['delivery'];
  native: boolean;
}

/** The notification a status transition triggers (channel + kind), or null. */
export function planNotification(
  prev: StatusFacts,
  next: StatusFacts,
  now: Date,
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
): PlannedNotification | null {
  const channel = chooseChannel(clients, entryId, nativeAvailable);
  if (channel === null) return null;
  const kind = notificationFor(prev, next, now, { minDoneTurnMs: channel.minDoneTurnMs });
  return kind === null
    ? null
    : { clientId: channel.clientId, kind, delivery: channel.delivery, native: channel.native };
}

/** The last open decision is gone → clear the entry's notification (answered elsewhere). */
export function decisionsCleared(prev: StatusFacts, next: StatusFacts): boolean {
  return openDecisionCount(prev) > 0 && openDecisionCount(next) === 0;
}
