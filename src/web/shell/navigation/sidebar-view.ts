import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import type { SidebarGrouping } from '@web/lib/session-order';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/**
 * View state of the sidebar (window-local, Plan "Sidebar"), module-level so the shortcuts, the
 * quick switcher and playground demos see the same state:
 * - WP-80 (WP-75 §4.4, ADR-226): "Group by" computer and/or folder (`SidebarGrouping`) in
 *   localStorage `parallax.sidebar.mode` – `flat`, `grouped` (folder; the value of WP-35, so an
 *   older version still reads it), `host`, `host+folder`. `byHost` only takes effect while other
 *   computers are part of the window (the sidebar decides, `effectiveGrouping`).
 * - WP-80: collapsed groups (keys `host:<id>` / `folder:<id>|<path>`) per window (sessionStorage)
 *   and as the default of new windows (localStorage); groups that no longer exist are dropped on
 *   read (`pruneCollapsedGroups`).
 * - whether the archive is shown (not kept).
 * The WP-35 API (`SidebarMode` `flat` | `grouped`, `getSidebarMode`, `setSidebarMode`,
 * `useSidebarMode`) stays: it reads and sets "by folder" and keeps "by computer".
 */
export const SIDEBAR_MODES = ['flat', 'grouped'] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

export type { SidebarGrouping };

/** Stored value of a grouping (`grouped` = by folder, as WP-35 wrote it). */
const GROUPING_VALUES: Readonly<Record<string, SidebarGrouping>> = {
  flat: { byHost: false, byFolder: false },
  grouped: { byHost: false, byFolder: true },
  host: { byHost: true, byFolder: false },
  'host+folder': { byHost: true, byFolder: true },
};

function groupingValue(grouping: SidebarGrouping): string {
  if (grouping.byHost) return grouping.byFolder ? 'host+folder' : 'host';
  return grouping.byFolder ? 'grouped' : 'flat';
}

function storedGrouping(): SidebarGrouping {
  const value = readStorage('local', STORAGE_KEYS.sidebarMode);
  return (value === null ? undefined : GROUPING_VALUES[value]) ?? { byHost: false, byFolder: false };
}

/** Longest collapse key kept (a folder key carries a full path). */
const GROUP_KEY_MAX = 2048;
/** Most collapsed groups kept. */
const COLLAPSED_MAX = 512;
const collapsedSchema = z.array(z.string().min(1).max(GROUP_KEY_MAX)).max(COLLAPSED_MAX);

function parseCollapsed(raw: string | null): ReadonlySet<string> | null {
  if (raw === null) return null;
  try {
    const parsed = collapsedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? new Set(parsed.data) : null;
  } catch {
    return null;
  }
}

function storedCollapsed(): ReadonlySet<string> {
  return (
    parseCollapsed(readStorage('session', STORAGE_KEYS.sidebarCollapsedGroups)) ??
    parseCollapsed(readStorage('local', STORAGE_KEYS.sidebarCollapsedGroups)) ??
    new Set()
  );
}

function writeCollapsed(keys: ReadonlySet<string>): void {
  const value = JSON.stringify([...keys].slice(0, COLLAPSED_MAX));
  writeStorage('session', STORAGE_KEYS.sidebarCollapsedGroups, value);
  writeStorage('local', STORAGE_KEYS.sidebarCollapsedGroups, value);
}

interface SidebarView {
  grouping: SidebarGrouping;
  collapsed: ReadonlySet<string>;
  archive: boolean;
}

let view: SidebarView = { grouping: storedGrouping(), collapsed: storedCollapsed(), archive: false };
const listeners = new Set<() => void>();

function update(next: Partial<SidebarView>): void {
  const merged = { ...view, ...next };
  if (
    merged.grouping === view.grouping &&
    merged.collapsed === view.collapsed &&
    merged.archive === view.archive
  )
    return;
  view = merged;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---- grouping ----

export function getSidebarGrouping(): SidebarGrouping {
  return view.grouping;
}

/** Changes only the given parts ("Group by" checkboxes). */
export function setSidebarGrouping(patch: Partial<SidebarGrouping>): void {
  const next = { ...view.grouping, ...patch };
  if (next.byHost === view.grouping.byHost && next.byFolder === view.grouping.byFolder) return;
  writeStorage('local', STORAGE_KEYS.sidebarMode, groupingValue(next));
  update({ grouping: next });
}

export function useSidebarGrouping(): SidebarGrouping {
  return useSyncExternalStore(subscribe, getSidebarGrouping, getSidebarGrouping);
}

/** The grouping in effect: "by computer" only while other computers are part of the window. */
export function effectiveGrouping(grouping: SidebarGrouping, hasRemoteHosts: boolean): SidebarGrouping {
  return grouping.byHost && !hasRemoteHosts ? { byHost: false, byFolder: grouping.byFolder } : grouping;
}

/** WP-35 view: `grouped` = by folder. */
export function getSidebarMode(): SidebarMode {
  return view.grouping.byFolder ? 'grouped' : 'flat';
}

/** WP-35 API: sets "by folder" (`grouped`) or not (`flat`); "by computer" stays as it is. */
export function setSidebarMode(mode: SidebarMode): void {
  setSidebarGrouping({ byFolder: mode === 'grouped' });
  // Keep the stored value in step even when nothing changed (WP-35 behaviour).
  writeStorage('local', STORAGE_KEYS.sidebarMode, groupingValue(view.grouping));
}

export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(subscribe, getSidebarMode, getSidebarMode);
}

// ---- collapsed groups ----

export function getCollapsedGroups(): ReadonlySet<string> {
  return view.collapsed;
}

export function useCollapsedGroups(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getCollapsedGroups, getCollapsedGroups);
}

export function setGroupCollapsed(key: string, collapsed: boolean): void {
  if (view.collapsed.has(key) === collapsed) return;
  const next = new Set(view.collapsed);
  if (collapsed) next.add(key);
  else next.delete(key);
  writeCollapsed(next);
  update({ collapsed: next });
}

/** Expands the given groups (Alt+N, "Waiting for you": the target's groups). */
export function expandGroups(keys: readonly string[]): void {
  if (!keys.some((key) => view.collapsed.has(key))) return;
  const next = new Set(view.collapsed);
  for (const key of keys) next.delete(key);
  writeCollapsed(next);
  update({ collapsed: next });
}

/**
 * Drops collapsed keys of groups that no longer exist (WP-75 §4.4 "vanished groups are dropped
 * on read"). Call it only with the complete list of groups (all summaries loaded).
 */
export function pruneCollapsedGroups(existing: Iterable<string>): void {
  const known = new Set(existing);
  const kept = [...view.collapsed].filter((key) => known.has(key));
  if (kept.length === view.collapsed.size) return;
  const next = new Set(kept);
  writeCollapsed(next);
  update({ collapsed: next });
}

// ---- archive ----

export function isArchiveView(): boolean {
  return view.archive;
}

export function setArchiveView(archive: boolean): void {
  update({ archive });
}

export function useArchiveView(): boolean {
  return useSyncExternalStore(subscribe, isArchiveView, isArchiveView);
}

/** Tests: back to the stored grouping and collapsed groups, archive hidden. */
export function resetSidebarView(): void {
  update({ grouping: storedGrouping(), collapsed: storedCollapsed(), archive: false });
}
