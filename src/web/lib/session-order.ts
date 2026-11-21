import { WIN32_PATHS } from '@shared/paths';
import type { SessionSummary } from '@shared/model';
import { deriveDisplayStatus, type DisplayStatus } from '@shared/status';
import { pathTail } from './path-display';
import { sessionTitle } from './session-title';

/**
 * Sidebar order (Plan "Sidebar"): by the contract's `sortBucket` (0 attention … 4 rest), then
 * newest activity, then title. Archived entries are left out unless `includeArchived`.
 * Phase 2 (WP-35): flat = pinned first, grouped = by project folder (`pathKey(hostId, cwd)`: the
 * path rules of the entry's host, WP-104; default case-insensitive as on Windows).
 * WP-80: `sidebarLayout` groups by computer and/or folder; collapsed groups leave the visible order.
 * WP-115 (Ausbau 1): a worktree session belongs to the project of its main repository
 * (`sessionProjectPath`, ADR-250); the sidebar filter (status and text, `SidebarFilter`) narrows the
 * layout, which keeps the unfiltered one for "next waiting".
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

/**
 * WP-115 (ADR-250): the project of an entry – the main repository of a worktree session
 * (`worktree.repoRoot`, exact string), else its folder. The sidebar groups by it and muted projects
 * (`notifications.mutedProjects`) name it.
 */
export function sessionProjectPath(summary: Pick<SessionSummary, 'cwd' | 'worktree'>): string {
  return summary.worktree?.repoRoot ?? summary.cwd;
}

/** One project group of the grouped sidebar. */
export interface SessionGroup<T> {
  /**
   * `pathKey(hostId, project)` (`sessionProjectPath`), prefixed with the host id when the entries
   * carry one (multi-host).
   */
  key: string;
  /**
   * Full project folder of the group (spelling of its most recently active entry; the main
   * repository for worktree sessions) – tooltip, "new session here", muting.
   */
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

/**
 * Comparison key of a folder on the entry's host (WP-104: case-sensitive on Linux). The caller
 * passes the rules of its hosts (`useHostPathKey`); default: every folder as on Windows.
 */
export type FolderKey = (hostId: string | undefined, path: string) => string;

const WINDOWS_FOLDER_KEY: FolderKey = (_hostId, path) => WIN32_PATHS.key(path);

function groupKeyOf(entry: WithSummary & { hostId?: string }, pathKey: FolderKey): string {
  const path = pathKey(entry.hostId, sessionProjectPath(entry.summary));
  return entry.hostId === undefined ? path : `${entry.hostId}|${path}`;
}

/**
 * Grouped sidebar (Plan "gruppiert nach Projekt"): non-archived entries per project folder
 * (by the rules of the entry's host, `pathKey`); groups with a pinned entry first (V3-14, as in the flat
 * list), then groups with attention, then newest activity, then label. WP-115: worktree sessions
 * join the group of their main repository (`sessionProjectPath`), not one group per worktree.
 */
export function groupSessions<T extends WithSummary & { hostId?: string }>(
  entries: readonly T[],
  now: Date,
  pathKey: FolderKey = WINDOWS_FOLDER_KEY,
): SessionGroup<T>[] {
  const groups = new Map<string, SessionGroup<T>>();
  for (const item of orderSessions(entries, now)) {
    const key = groupKeyOf(item.entry, pathKey);
    const activity = Date.parse(item.entry.summary.lastActivityAt);
    const project = sessionProjectPath(item.entry.summary);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        key,
        cwd: project,
        label: pathTail(project),
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
      group.cwd = project;
      group.label = pathTail(project);
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

// ---- WP-80: "Group by" computer and/or folder, collapsible groups (WP-75 §4.4, ADR-226) ----

/** What the sidebar groups by; neither = flat. `byHost` only takes effect with other computers. */
export interface SidebarGrouping {
  byHost: boolean;
  byFolder: boolean;
}

/** Collapse key of a computer group. */
export function hostGroupKey(hostId: string): string {
  return `host:${hostId}`;
}

/** Collapse key of a folder group (its `SessionGroup.key` already carries the computer). */
export function folderGroupKey(group: Pick<SessionGroup<unknown>, 'key'>): string {
  return `folder:${group.key}`;
}

/** Entries that need the user (header counter "waiting"). */
export function waitingCount<T>(sessions: readonly OrderedSession<T>[]): number {
  let count = 0;
  for (const item of sessions) if (item.status.needsAttention) count++;
  return count;
}

/** One computer of the sidebar grouped by computer. */
export interface HostSection<T> {
  /** `hostGroupKey(hostId)`. */
  key: string;
  hostId: string;
  /** Grouped by folder as well: the folder groups of this computer; else null. */
  folders: SessionGroup<T>[] | null;
  /** The computer's entries in display order (flat: pinned first; with folders: folder by folder). */
  sessions: OrderedSession<T>[];
  waiting: number;
}

/** The sidebar for one grouping: the blocks to render and the full order. */
export interface SidebarLayout<T> {
  /** Grouped by computer: one section per computer in fixed order (this computer first); else null. */
  hosts: HostSection<T>[] | null;
  /** Grouped by folder only: the folder groups (same path on two computers = two groups); else null. */
  folders: SessionGroup<T>[] | null;
  /** Every entry in display order, collapsed groups included ("next waiting", the rail). */
  order: OrderedSession<T>[];
  /**
   * WP-115: the same layout without the sidebar filter – set only while a filter is active (the
   * entries above are the matching ones). "Next waiting" counts and jumps over it.
   */
  unfiltered?: SidebarLayout<T>;
}

type WithHost = WithSummary & { hostId: string };

// ---- WP-115 (F6): the sidebar filter (status and text, window-local) ----

/** "All", "Waiting for me", "Working", "Unread" (WP-110 §3.7). */
export const SIDEBAR_STATUS_FILTERS = ['all', 'waiting', 'working', 'unread'] as const;
export type SidebarStatusFilter = (typeof SIDEBAR_STATUS_FILTERS)[number];

export interface SidebarFilter {
  status: SidebarStatusFilter;
  /** Words that must all occur in title, folder or branch (case-insensitive); '' = none. */
  text: string;
}

export const NO_SIDEBAR_FILTER: SidebarFilter = Object.freeze({ status: 'all', text: '' });

/** A filter narrows the list (a status other than "all", or a text). */
export function sidebarFilterActive(filter: SidebarFilter): boolean {
  return filter.status !== 'all' || filter.text.trim() !== '';
}

/** Waiting = needs the user; working = starting, working or in the background; unread = the dot. */
export function matchesStatusFilter(status: DisplayStatus, filter: SidebarStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'waiting':
      return status.needsAttention;
    case 'working':
      return status.sortBucket === 2;
    case 'unread':
      return status.unread;
  }
}

/** The words of a text filter, lower case. */
function filterWords(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** What the text filter looks at: title, folder, the worktree's repository, branch. */
function filterHaystack(summary: SessionSummary): string {
  return [
    sessionTitle(summary),
    summary.cwd,
    summary.worktree?.repoRoot ?? '',
    summary.gitBranch ?? '',
    summary.worktree?.branch ?? '',
  ]
    .join('\n')
    .toLocaleLowerCase();
}

/** True when the entry passes the filter (status and every word of the text). */
export function matchesSidebarFilter(
  summary: SessionSummary,
  status: DisplayStatus,
  filter: SidebarFilter,
): boolean {
  if (!matchesStatusFilter(status, filter.status)) return false;
  const words = filterWords(filter.text);
  if (words.length === 0) return true;
  const haystack = filterHaystack(summary);
  return words.every((word) => haystack.includes(word));
}

/** Entries per status filter (non-archived; the counters of the filter buttons). */
export function sidebarFilterCounts(
  entries: readonly WithSummary[],
  now: Date,
): Readonly<Record<SidebarStatusFilter, number>> {
  const counts: Record<SidebarStatusFilter, number> = { all: 0, waiting: 0, working: 0, unread: 0 };
  for (const entry of entries) {
    if (entry.summary.archived) continue;
    const status = deriveDisplayStatus(entry.summary.status, now);
    for (const filter of SIDEBAR_STATUS_FILTERS) if (matchesStatusFilter(status, filter)) counts[filter]++;
  }
  return counts;
}

/**
 * The sidebar layout (WP-75 §4.4): neither = flat (pinned first); folder = the folder groups of
 * `groupSessions`; computer = one block per computer in `hostOrder` (this computer first, then the
 * list of computers; a computer without entries keeps its block, an unknown one comes last), inside
 * flat or by folder. WP-115: an active `filter` keeps only the matching entries and adds the
 * layout without it (`unfiltered`).
 */
export function sidebarLayout<T extends WithHost>(
  entries: readonly T[],
  now: Date,
  grouping: SidebarGrouping,
  hostOrder: readonly string[],
  pathKey: FolderKey = WINDOWS_FOLDER_KEY,
  filter: SidebarFilter = NO_SIDEBAR_FILTER,
): SidebarLayout<T> {
  const unfiltered = groupedLayout(entries, now, grouping, hostOrder, pathKey);
  if (!sidebarFilterActive(filter)) return unfiltered;
  const kept = entries.filter((entry) =>
    matchesSidebarFilter(entry.summary, deriveDisplayStatus(entry.summary.status, now), filter),
  );
  return { ...groupedLayout(kept, now, grouping, hostOrder, pathKey), unfiltered };
}

function groupedLayout<T extends WithHost>(
  entries: readonly T[],
  now: Date,
  grouping: SidebarGrouping,
  hostOrder: readonly string[],
  pathKey: FolderKey,
): SidebarLayout<T> {
  if (!grouping.byHost) {
    if (!grouping.byFolder) return { hosts: null, folders: null, order: flatSidebarOrder(entries, now) };
    const folders = groupSessions(entries, now, pathKey);
    return { hosts: null, folders, order: groupedOrder(folders) };
  }
  const byHost = new Map<string, T[]>();
  for (const hostId of hostOrder) byHost.set(hostId, []);
  for (const entry of entries) {
    const list = byHost.get(entry.hostId);
    if (list === undefined) byHost.set(entry.hostId, [entry]);
    else list.push(entry);
  }
  const hosts = [...byHost].map(([hostId, own]): HostSection<T> => {
    const folders = grouping.byFolder ? groupSessions(own, now, pathKey) : null;
    const sessions = folders === null ? flatSidebarOrder(own, now) : groupedOrder(folders);
    return { key: hostGroupKey(hostId), hostId, folders, sessions, waiting: waitingCount(sessions) };
  });
  return { hosts, folders: null, order: hosts.flatMap((host) => host.sessions) };
}

/** Every collapse key of a layout (computer and folder groups). */
export function layoutGroupKeys<T>(layout: SidebarLayout<T>): string[] {
  const keys: string[] = [];
  for (const host of layout.hosts ?? []) {
    keys.push(host.key);
    for (const folder of host.folders ?? []) keys.push(folderGroupKey(folder));
  }
  for (const folder of layout.folders ?? []) keys.push(folderGroupKey(folder));
  return keys;
}

/** The visible order (Alt+1…9): entries of collapsed groups are left out. */
export function visibleSidebarOrder<T>(
  layout: SidebarLayout<T>,
  collapsed: ReadonlySet<string>,
): OrderedSession<T>[] {
  const ofFolders = (folders: readonly SessionGroup<T>[]) =>
    folders.flatMap((folder) => (collapsed.has(folderGroupKey(folder)) ? [] : folder.sessions));
  if (layout.hosts !== null) {
    return layout.hosts.flatMap((host) => {
      if (collapsed.has(host.key)) return [];
      return host.folders === null ? host.sessions : ofFolders(host.folders);
    });
  }
  if (layout.folders !== null) return ofFolders(layout.folders);
  return layout.order;
}

/** Collapse keys of the groups that hold `entry` (to expand them for Alt+N and "Waiting for you"). */
export function groupKeysOfEntry<T>(layout: SidebarLayout<T>, entry: T): string[] {
  const keys: string[] = [];
  const holds = (sessions: readonly OrderedSession<T>[]) => sessions.some((item) => item.entry === entry);
  for (const host of layout.hosts ?? []) {
    if (!holds(host.sessions)) continue;
    keys.push(host.key);
    for (const folder of host.folders ?? []) if (holds(folder.sessions)) keys.push(folderGroupKey(folder));
  }
  for (const folder of layout.folders ?? []) if (holds(folder.sessions)) keys.push(folderGroupKey(folder));
  return keys;
}
