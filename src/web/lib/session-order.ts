import { windowsPathKey } from '@shared/paths';
import type { SessionSummary } from '@shared/model';
import { deriveDisplayStatus, type DisplayStatus } from '@shared/status';
import { pathTail } from './path-display';
import { sessionTitle } from './session-title';

/**
 * Sidebar order (Plan "Sidebar"): by the contract's `sortBucket` (0 attention … 4 rest), then
 * newest activity, then title. Archived entries are left out unless `includeArchived`.
 * Phase 2 (WP-35): flat = pinned first, grouped = by project folder (`windowsPathKey(cwd)`).
 */
export interface OrderedSession<T> {
  entry: T;
  status: DisplayStatus;
}

interface WithSummary {
  summary: SessionSummary;
}

function compareOrdered<T extends WithSummary>(a: OrderedSession<T>, b: OrderedSession<T>): number {
  if (a.status.sortBucket !== b.status.sortBucket) return a.status.sortBucket - b.status.sortBucket;
  const activity = Date.parse(b.entry.summary.lastActivityAt) - Date.parse(a.entry.summary.lastActivityAt);
  if (activity !== 0) return activity;
  return sessionTitle(a.entry.summary).localeCompare(sessionTitle(b.entry.summary));
}

export function orderSessions<T extends WithSummary>(
  entries: readonly T[],
  now: Date,
  options: { includeArchived?: boolean } = {},
): OrderedSession<T>[] {
  return entries
    .filter((entry) => options.includeArchived === true || !entry.summary.archived)
    .map((entry) => ({ entry, status: deriveDisplayStatus(entry.summary.status, now) }))
    .sort(compareOrdered);
}

/** Pinned entries first (each part in `orderSessions` order); the input must already be ordered. */
export function pinnedFirst<T extends WithSummary>(
  ordered: readonly OrderedSession<T>[],
): OrderedSession<T>[] {
  return [
    ...ordered.filter((item) => item.entry.summary.pinned),
    ...ordered.filter((item) => !item.entry.summary.pinned),
  ];
}

/** Flat sidebar list: non-archived entries, pinned first, then bucket → activity → title. */
export function flatSidebarOrder<T extends WithSummary>(
  entries: readonly T[],
  now: Date,
): OrderedSession<T>[] {
  return pinnedFirst(orderSessions(entries, now));
}

/** Archive view: archived entries only, newest activity first. */
export function archivedOrder<T extends WithSummary>(entries: readonly T[], now: Date): OrderedSession<T>[] {
  return entries
    .filter((entry) => entry.summary.archived)
    .map((entry) => ({ entry, status: deriveDisplayStatus(entry.summary.status, now) }))
    .sort(
      (a, b) =>
        Date.parse(b.entry.summary.lastActivityAt) - Date.parse(a.entry.summary.lastActivityAt) ||
        sessionTitle(a.entry.summary).localeCompare(sessionTitle(b.entry.summary)),
    );
}

/** One project group of the grouped sidebar. */
export interface SessionGroup<T> {
  /** `windowsPathKey(cwd)`, prefixed with the host id when the entries carry one (multi-host). */
  key: string;
  /** Full folder of the group (spelling of its most recently active entry) – tooltip, "new session here". */
  cwd: string;
  /** Display label: `pathTail(cwd)`. */
  label: string;
  /** At least one entry needs the user. */
  attention: boolean;
  /** At least one entry is pinned (such groups come first, like pinned entries in the flat list). */
  pinned: boolean;
  /** Newest `lastActivityAt` of the group (epoch ms). */
  lastActivity: number;
  /** Pinned first, then bucket → activity → title. */
  sessions: OrderedSession<T>[];
}

function groupKeyOf(entry: WithSummary & { hostId?: string }): string {
  const path = windowsPathKey(entry.summary.cwd);
  return entry.hostId === undefined ? path : `${entry.hostId}|${path}`;
}

/**
 * Grouped sidebar (Plan "gruppiert nach Projekt"): non-archived entries per project folder
 * (case-insensitive, `windowsPathKey`); groups with a pinned entry first (V3-14, as in the flat
 * list), then groups with attention, then newest activity, then label.
 */
export function groupSessions<T extends WithSummary & { hostId?: string }>(
  entries: readonly T[],
  now: Date,
): SessionGroup<T>[] {
  const groups = new Map<string, SessionGroup<T>>();
  for (const item of orderSessions(entries, now)) {
    const key = groupKeyOf(item.entry);
    const activity = Date.parse(item.entry.summary.lastActivityAt);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        key,
        cwd: item.entry.summary.cwd,
        label: pathTail(item.entry.summary.cwd),
        attention: item.status.needsAttention,
        pinned: item.entry.summary.pinned,
        lastActivity: activity,
        sessions: [item],
      });
      continue;
    }
    group.sessions.push(item);
    group.attention ||= item.status.needsAttention;
    group.pinned ||= item.entry.summary.pinned;
    if (activity > group.lastActivity) {
      group.lastActivity = activity;
      group.cwd = item.entry.summary.cwd;
      group.label = pathTail(item.entry.summary.cwd);
    }
  }
  const result = [...groups.values()];
  for (const group of result) group.sessions = pinnedFirst(group.sessions);
  return result.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.attention !== b.attention) return a.attention ? -1 : 1;
    return b.lastActivity - a.lastActivity || a.label.localeCompare(b.label);
  });
}

/** Waiting entries first (quick switcher, ADR-118); the order inside both parts is kept. */
export function waitingFirst<T>(ordered: readonly OrderedSession<T>[]): OrderedSession<T>[] {
  return [
    ...ordered.filter((item) => item.status.needsAttention),
    ...ordered.filter((item) => !item.status.needsAttention),
  ];
}

/** The visible order of a grouped sidebar (Alt+1…9, "next waiting"). */
export function groupedOrder<T>(groups: readonly SessionGroup<T>[]): OrderedSession<T>[] {
  return groups.flatMap((group) => group.sessions);
}

/**
 * "Next session waiting for you" (ADR-118, Alt+N and the "Waiting for you (n)" button): the first
 * entry that needs attention AFTER `currentKey` in `order`, cyclically; without (a visible) current
 * selection the first waiting one. Null when nothing waits.
 */
export function nextWaiting<T>(
  order: readonly OrderedSession<T>[],
  currentKey: string | null,
  keyOf: (entry: T) => string,
): T | null {
  const start = currentKey === null ? -1 : order.findIndex((item) => keyOf(item.entry) === currentKey);
  for (let step = 1; step <= order.length; step++) {
    const item = order[(start + step + order.length) % order.length];
    if (item?.status.needsAttention === true) return item.entry;
  }
  return null;
}
