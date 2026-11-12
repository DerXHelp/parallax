import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

/**
 * Sidebar in narrow windows (V3-14, WP-58): below NARROW_WINDOW_BELOW px of window width the
 * sidebar is collapsed into a rail (status icons, "Show sessions") and opens as an overlay. In a
 * wider window the user may collapse it as well; that choice is kept per window (sessionStorage)
 * and as the default of new windows (localStorage) – both through lib/storage, which swallows
 * missing or broken storage (then: expanded).
 */

/** Window width (px) below which the sidebar is always collapsed. */
export const NARROW_WINDOW_BELOW = 900;

function windowWidth(): number {
  return typeof window === 'undefined' ? 0 : window.innerWidth;
}

/** True for a known window width below NARROW_WINDOW_BELOW. */
export function isNarrowWindow(width: number = windowWidth()): boolean {
  return width > 0 && width < NARROW_WINDOW_BELOW;
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  return () => {
    window.removeEventListener('resize', listener);
  };
}

function narrowNow(): boolean {
  return isNarrowWindow();
}

function never(): boolean {
  return false;
}

/** Re-renders when the window crosses NARROW_WINDOW_BELOW. */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribeResize, narrowNow, never);
}

function parseCollapsed(value: string | null): boolean | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** The stored choice: this window's own value, else the last one of any window; default expanded. */
export function readSidebarCollapsed(): boolean {
  return (
    parseCollapsed(readStorage('session', STORAGE_KEYS.sidebarCollapsed)) ??
    parseCollapsed(readStorage('local', STORAGE_KEYS.sidebarCollapsed)) ??
    false
  );
}

let collapsed = readSidebarCollapsed();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribeCollapsed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isSidebarCollapsed(): boolean {
  return collapsed;
}

/** Collapses or expands the sidebar of a wide window and remembers it (errors are swallowed). */
export function setSidebarCollapsed(next: boolean): void {
  const value = String(next);
  writeStorage('session', STORAGE_KEYS.sidebarCollapsed, value);
  writeStorage('local', STORAGE_KEYS.sidebarCollapsed, value);
  if (collapsed === next) return;
  collapsed = next;
  notify();
}

/** The user's choice for wide windows (narrow windows are always collapsed). */
export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribeCollapsed, isSidebarCollapsed, isSidebarCollapsed);
}

/** Tests: read the stored choice again. */
export function resetSidebarLayout(): void {
  const next = readSidebarCollapsed();
  if (collapsed === next) return;
  collapsed = next;
  notify();
}
