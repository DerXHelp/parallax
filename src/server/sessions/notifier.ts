/**
 * Notification channel (WP-13 §3.5.15, A.9, architecture §5 "Präsenz"), pure and table-tested:
 * exactly one channel per event. A focused + visible window shows the entry → nothing; another
 * focused + visible window → `in_app` there (done only for turns ≥ DONE_NOTIFY_MIN_TURN_MS);
 * otherwise `system` to the last focused client (every done); without a client nothing (Phase 2:
 * native toast). Which event: `notificationFor` (@shared/status).
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
  clientId: ClientId;
  delivery: Notification['delivery'];
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
): NotificationChannel | null {
  const active = clients.filter((c) => c.presence.focused && c.presence.visible);
  if (active.some((c) => c.presence.viewingEntryId === entryId)) return null;
  const window = lastFocused(active);
  if (window !== null) {
    return { clientId: window.clientId, delivery: 'in_app', minDoneTurnMs: DONE_NOTIFY_MIN_TURN_MS };
  }
  const target = lastFocused(clients);
  return target === null ? null : { clientId: target.clientId, delivery: 'system', minDoneTurnMs: 0 };
}

/** A client shows this entry visibly (presence) → no unread (ReduceStatusContext). */
export function isViewedByVisibleClient(clients: readonly ClientPresence[], entryId: EntryId): boolean {
  return clients.some((c) => c.presence.visible && c.presence.viewingEntryId === entryId);
}

export interface PlannedNotification {
  clientId: ClientId;
  kind: NotificationKind;
  delivery: Notification['delivery'];
}

/** The notification a status transition triggers (channel + kind), or null. */
export function planNotification(
  prev: StatusFacts,
  next: StatusFacts,
  now: Date,
  clients: readonly ClientPresence[],
  entryId: EntryId,
): PlannedNotification | null {
  const channel = chooseChannel(clients, entryId);
  if (channel === null) return null;
  const kind = notificationFor(prev, next, now, { minDoneTurnMs: channel.minDoneTurnMs });
  return kind === null ? null : { clientId: channel.clientId, kind, delivery: channel.delivery };
}

/** The last open decision is gone → clear the entry's notification (answered elsewhere). */
export function decisionsCleared(prev: StatusFacts, next: StatusFacts): boolean {
  return openDecisionCount(prev) > 0 && openDecisionCount(next) === 0;
}
