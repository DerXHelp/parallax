import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/**
 * View state of the sidebar (window-local, Plan "Sidebar"): `flat` or `grouped` (by project folder,
 * kept in localStorage `parallax.sidebar.mode`) and whether the archive is shown (not kept).
 * Module-level so the shortcuts, the quick switcher and playground demos see the same state.
 */
export const SIDEBAR_MODES = ['flat', 'grouped'] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

interface SidebarView {
  mode: SidebarMode;
  archive: boolean;
}

function storedMode(): SidebarMode {
  const value = readStorage('local', STORAGE_KEYS.sidebarMode);
  return value === 'grouped' ? 'grouped' : 'flat';
}

let view: SidebarView = { mode: storedMode(), archive: false };
const listeners = new Set<() => void>();

function update(next: Partial<SidebarView>): void {
  const merged = { ...view, ...next };
  if (merged.mode === view.mode && merged.archive === view.archive) return;
  view = merged;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSidebarMode(): SidebarMode {
  return view.mode;
}

export function setSidebarMode(mode: SidebarMode): void {
  writeStorage('local', STORAGE_KEYS.sidebarMode, mode);
  update({ mode });
}

export function isArchiveView(): boolean {
  return view.archive;
}

export function setArchiveView(archive: boolean): void {
  update({ archive });
}

/** Tests: back to the stored mode, archive hidden. */
export function resetSidebarView(): void {
  update({ mode: storedMode(), archive: false });
}

export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(subscribe, getSidebarMode, getSidebarMode);
}

export function useArchiveView(): boolean {
  return useSyncExternalStore(subscribe, isArchiveView, isArchiveView);
}
