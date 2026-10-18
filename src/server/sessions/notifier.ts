/**
 * Notification channel (WP-13 §3.5.15, A.9, architecture §5 "Präsenz"; Phase 2 ADR-109), pure and
 * table-tested: at most one channel per event.
 *
 * Channel: a focused + visible window shows the entry → nothing; another focused + visible window →
 * `in_app` there (`settings.notifications.focusedElsewhere 'in_app'`, default) or `system` to that
 * window (`'system'`); otherwise `system` to the last focused client – on a tie (also: never focused)
 * ADR-129 prefers clients that can show Web Notifications, then visible ones, then the most recently
 * connected (`notificationTarget`). "done" needs a turn of at least
 * `doneMinSeconds` when the target window is focused, any length otherwise. WP22-03/-15 (Plan A.9)
 * with native toasts available (`nativeAvailable`): a `system` target that cannot show Web
 * Notifications (presence `systemNotifications: false`) → a native Windows toast plus the in-app
 * hint in that window; no client at all → a native toast only. Without native toasts: as before
 * (nothing without a client). Which event: `notificationFor` (@shared/status).
 *
 * Settings filter (ADR-109): "Nicht stören" (`doNotDisturb`) or `events[kind].toast === false` → no
 * OS notification (neither `system` nor native): the chosen client gets the `in_app` hint instead,
 * without a client nothing. Sounds are the client's business (it applies `sound` + DND itself).
 *
 * WP41-04: `routeNotification` also says WHY (ChannelReason, TieBreak, settings filter) and `presenceSummary`
 * condenses the presence for the engine's one debug line per notification (no titles, no texts).
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

/**
 * Why the channel went where it went (WP41-04, debug log):
 * - `viewing_focused` – a focused + visible window shows the entry → nothing;
 * - `focused_elsewhere` – another focused + visible window (the most recently focused of them);
 * - `last_focused` – no focused + visible window: the most recently focused client;
 * - `focus_tie` – same: several clients share the latest focus time → tie-break (TieBreak, ADR-129);
 * - `never_focused` – same: no client was ever focused → tie-break (TieBreak) if more than one;
 * - `no_client_native` – no client at all → native toast only;
 * - `no_client` – no client and no native toasts → nothing.
 */
export type ChannelReason =
  | 'viewing_focused'
  | 'focused_elsewhere'
  | 'last_focused'
  | 'focus_tie'
  | 'never_focused'
  | 'no_client_native'
  | 'no_client';

/**
 * Which stage of the target tie-break decided between clients with the same latest focus (also:
 * none ever focused) – ADR-129: (b) `notifications` – clients that can show Web Notifications
 * (`systemNotifications !== false`) first, (c) `visible` – visible ones first, (d) `connected` – the
 * most recently connected. null = no tie (one client had the latest focus).
 */
export type TieBreak = 'notifications' | 'visible' | 'connected';

/** chooseChannel plus its reason; `minDoneTurnMs` also when nothing is delivered (for the log). */
export interface ChannelChoice {
  channel: NotificationChannel | null;
  reason: ChannelReason;
  /** Only for `focus_tie`/`never_focused` with more than one candidate; otherwise null. */
  tieBreak: TieBreak | null;
  minDoneTurnMs: number;
}

function time(date: Date | null): number {
  return date === null ? Number.NEGATIVE_INFINITY : date.getTime();
}

/** The most recently connected of `clients` (the first one on equal times). */
function lastConnected(clients: readonly ClientPresence[]): ClientPresence | null {
  let best: ClientPresence | null = null;
  for (const client of clients) {
    if (best === null || client.connectedAt.getTime() > best.connectedAt.getTime()) best = client;
  }
  return best;
}

/**
 * Among focused + visible windows: the most recently focused (ties: most recently connected) –
 * unchanged by ADR-129.
 */
function lastFocusedWindow(windows: readonly ClientPresence[]): ClientPresence | null {
  const latest = Math.max(...windows.map((c) => time(c.lastFocusAt)));
  return lastConnected(windows.filter((c) => time(c.lastFocusAt) === latest));
}

interface TargetPick {
  client: ClientPresence;
  /** Several clients shared the latest focus time (also: none ever focused). */
  tie: boolean;
  tieBreak: TieBreak | null;
}

/** Keeps the preferred clients when the rule separates the group (some, not all, match). */
function prefer(
  group: readonly ClientPresence[],
  rule: (c: ClientPresence) => boolean,
): readonly ClientPresence[] {
  const preferred = group.filter(rule);
  return preferred.length > 0 && preferred.length < group.length ? preferred : group;
}

/**
 * The target without a focused + visible window (ADR-129): (a) the most recently focused client;
 * on a tie – also "never focused" – (b) Web Notifications possible before not, (c) visible before
 * hidden, (d) most recently connected. `tieBreak` names the stage that left one client.
 */
function notificationTarget(clients: readonly ClientPresence[]): TargetPick | null {
  if (clients.length === 0) return null;
  const latest = Math.max(...clients.map((c) => time(c.lastFocusAt)));
  let group: readonly ClientPresence[] = clients.filter((c) => time(c.lastFocusAt) === latest);
  const [only] = group;
  if (group.length === 1 && only !== undefined) return { client: only, tie: false, tieBreak: null };
  const stages: [TieBreak, (c: ClientPresence) => boolean][] = [
    ['notifications', (c) => c.presence.systemNotifications !== false],
    ['visible', (c) => c.presence.visible],
  ];
  for (const [stage, rule] of stages) {
    group = prefer(group, rule);
    const [single] = group;
    if (group.length === 1 && single !== undefined) return { client: single, tie: true, tieBreak: stage };
  }
  const connected = lastConnected(group);
  return connected === null ? null : { client: connected, tie: true, tieBreak: 'connected' };
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

/** The channel and why (see ChannelReason). */
export function chooseChannelWithReason(
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
  rules: ChannelRules = DEFAULT_CHANNEL_RULES,
): ChannelChoice {
  const active = clients.filter((c) => c.presence.focused && c.presence.visible);
  if (active.some((c) => c.presence.viewingEntryId === entryId)) {
    return {
      channel: null,
      reason: 'viewing_focused',
      tieBreak: null,
      minDoneTurnMs: rules.focusedDoneMinMs,
    };
  }
  const window = lastFocusedWindow(active);
  if (window !== null) {
    const minDoneTurnMs = rules.focusedDoneMinMs;
    const channel: NotificationChannel =
      rules.focusedElsewhere === 'system'
        ? systemChannel(window, nativeAvailable, minDoneTurnMs)
        : { clientId: window.clientId, delivery: 'in_app', native: false, minDoneTurnMs };
    return { channel, reason: 'focused_elsewhere', tieBreak: null, minDoneTurnMs };
  }
  const target = notificationTarget(clients);
  if (target === null) {
    return nativeAvailable
      ? {
          channel: { clientId: null, delivery: 'system', native: true, minDoneTurnMs: 0 },
          reason: 'no_client_native',
          tieBreak: null,
          minDoneTurnMs: 0,
        }
      : { channel: null, reason: 'no_client', tieBreak: null, minDoneTurnMs: 0 };
  }
  const reason: ChannelReason =
    target.client.lastFocusAt === null ? 'never_focused' : target.tie ? 'focus_tie' : 'last_focused';
  return {
    channel: systemChannel(target.client, nativeAvailable, 0),
    reason,
    tieBreak: target.tieBreak,
    minDoneTurnMs: 0,
  };
}

export function chooseChannel(
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
  rules: ChannelRules = DEFAULT_CHANNEL_RULES,
): NotificationChannel | null {
  return chooseChannelWithReason(clients, entryId, nativeAvailable, rules).channel;
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

/** The settings filter that turned an OS notification into the in-app hint (or into nothing). */
export type NotificationFilter = 'do_not_disturb' | 'toast_off';

/** One notification event: what is delivered (null = nothing) and why (WP41-04). */
export interface NotificationRoute {
  kind: NotificationKind;
  planned: PlannedNotification | null;
  reason: ChannelReason;
  tieBreak: TieBreak | null;
  filter: NotificationFilter | null;
}

/**
 * The route of the notification a status transition triggers, or null when it triggers none.
 * `notifications` = `settings.notifications` (ADR-109; default: the defaults of the settings schema).
 * `planned` is null when nothing is delivered (the focused window shows the entry, no client, or
 * the settings filter left nothing).
 */
export function routeNotification(
  prev: StatusFacts,
  next: StatusFacts,
  now: Date,
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
  notifications: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
): NotificationRoute | null {
  const { channel, reason, tieBreak, minDoneTurnMs } = chooseChannelWithReason(
    clients,
    entryId,
    nativeAvailable,
    {
      focusedElsewhere: notifications.focusedElsewhere,
      focusedDoneMinMs: notifications.doneMinSeconds * 1000,
    },
  );
  const kind = notificationFor(prev, next, now, { minDoneTurnMs });
  if (kind === null) return null;
  if (channel === null) return { kind, planned: null, reason, tieBreak, filter: null };
  const filter: NotificationFilter | null = notifications.doNotDisturb
    ? 'do_not_disturb'
    : notifications.events[kind].toast
      ? null
      : 'toast_off';
  if (filter !== null) {
    // No OS notification: the in-app hint in the chosen window only (none without a window).
    const planned: PlannedNotification | null =
      channel.clientId === null
        ? null
        : { clientId: channel.clientId, kind, delivery: 'in_app', native: false };
    return { kind, planned, reason, tieBreak, filter };
  }
  return {
    kind,
    planned: { clientId: channel.clientId, kind, delivery: channel.delivery, native: channel.native },
    reason,
    tieBreak,
    filter: null,
  };
}

/** The notification a status transition triggers (channel + kind), or null (routeNotification). */
export function planNotification(
  prev: StatusFacts,
  next: StatusFacts,
  now: Date,
  clients: readonly ClientPresence[],
  entryId: EntryId,
  nativeAvailable = false,
  notifications: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
): PlannedNotification | null {
  return (
    routeNotification(prev, next, now, clients, entryId, nativeAvailable, notifications)?.planned ?? null
  );
}

/** The delivered channel in one word: in-app hint, Web Notification, native toast (+ hint), nothing. */
export type RouteChannel = 'in_app' | 'system' | 'native' | 'native_in_app' | 'none';

export function routeChannel(planned: PlannedNotification | null): RouteChannel {
  if (planned === null) return 'none';
  if (planned.native) return planned.clientId === null ? 'native' : 'native_in_app';
  return planned.delivery;
}

/** Presence of one client in the notification log line (no titles, no texts). */
export interface ClientPresenceSummary {
  clientId: ClientId;
  focused: boolean;
  visible: boolean;
  /** WP22-03; null = the client does not report it (treated as able). */
  systemNotifications: boolean | null;
  /** Shows the notified entry. */
  viewing: boolean;
  /** lastFocusAt is set (the hub remembers it per window across reconnects, ADR-129). */
  everFocused: boolean;
  /** Rank by connectedAt, 1 = most recently connected (the tie-break of the channel choice). */
  connectedRank: number;
}

/** The presence condensed for the debug log line of a notification (WP41-04). */
export function presenceSummary(
  clients: readonly ClientPresence[],
  entryId: EntryId,
): { count: number; clients: ClientPresenceSummary[] } {
  const byConnect = [...clients].sort((a, b) => b.connectedAt.getTime() - a.connectedAt.getTime());
  return {
    count: clients.length,
    clients: clients.map((c) => ({
      clientId: c.clientId,
      focused: c.presence.focused,
      visible: c.presence.visible,
      systemNotifications: c.presence.systemNotifications ?? null,
      viewing: c.presence.viewingEntryId === entryId,
      everFocused: c.lastFocusAt !== null,
      connectedRank: byConnect.indexOf(c) + 1,
    })),
  };
}

/** The last open decision is gone → clear the entry's notification (answered elsewhere). */
export function decisionsCleared(prev: StatusFacts, next: StatusFacts): boolean {
  return openDecisionCount(prev) > 0 && openDecisionCount(next) === 0;
}
