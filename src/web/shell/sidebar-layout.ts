import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';
import { toLayoutPx } from '@web/lib/zoom';
import { getZoom, subscribeZoom } from '@web/state/zoom';

/**
 * Sidebar in narrow windows (V3-14, WP-58): below NARROW_WINDOW_BELOW px of window width the
 * sidebar is collapsed into a rail (status icons, "Show sessions") and opens as an overlay. In a
 * wider window the user may collapse it as well; that choice is kept per window (sessionStorage)
 * and as the default of new windows (localStorage) – both through lib/storage, which swallows
 * missing or broken storage (then: expanded).
 *
 * WP-92: every width here is in layout px (CSS px at a 16 px root) – the window width is divided by
 * the zoom, so the sidebar collapses at the same amount of content as without zoom.
 */

/** Window width (px) below which the sidebar is always collapsed. */
export const NARROW_WINDOW_BELOW = 900;

function windowWidth(): number {
  return typeof window === 'undefined' ? 0 : toLayoutPx(window.innerWidth, getZoom());
}

/** True for a known window width below NARROW_WINDOW_BELOW. */
export function isNarrowWindow(width: number = windowWidth()): boolean {
  return width > 0 && width < NARROW_WINDOW_BELOW;
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener('resize', listener);
  const unsubscribeZoom = subscribeZoom(listener);
  return () => {
    window.removeEventListener('resize', listener);
    unsubscribeZoom();
  };
}

function narrowNow(): boolean {
  return isNarrowWindow();
}

function never(): boolean {
  return false;
}

/** Re-renders when the window (in layout px) crosses NARROW_WINDOW_BELOW. */
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

// ---- Width of the expanded sidebar (WP-90, GitHub #4) ----

/** Default width (the former fixed `w-72`; the two-line rows need the room, Plan "Sidebar"). */
export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 480;
/** Largest share of the window, so the session area keeps its room. */
export const SIDEBAR_MAX_SHARE = 0.4;
/**
 * Lowest value of the resize handle: dragged (or moved by a key) below SIDEBAR_MIN_WIDTH the
 * sidebar collapses into the rail when let go – the width shown never goes below the minimum.
 */
export const SIDEBAR_SNAP_WIDTH = 120;
/** Collapses or expands the sidebar (WP-90; Ctrl+B is `composer.backgroundAll`). */
export const SIDEBAR_TOGGLE_KEYS = 'Alt+B';

/** Largest width for a window of `width` px (never below the minimum). */
export function sidebarMaxWidth(width: number = windowWidth()): number {
  const share = width > 0 ? Math.floor(width * SIDEBAR_MAX_SHARE) : SIDEBAR_MAX_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, share));
}

function maxWidthNow(): number {
  // Narrow windows show the rail or the overlay (no handle): no re-render per resize event there.
  return isNarrowWindow() ? SIDEBAR_MAX_WIDTH : sidebarMaxWidth();
}

function fullMaxWidth(): number {
  return SIDEBAR_MAX_WIDTH;
}

/** The largest width this window allows for the expanded sidebar; re-renders when it changes. */
export function useSidebarMaxWidth(): number {
  return useSyncExternalStore(subscribeResize, maxWidthNow, fullMaxWidth);
}

/** `width` within the minimum and SIDEBAR_MAX_WIDTH (the window share: `useSidebarMaxWidth`). */
export function clampSidebarWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
}

function parseWidth(value: string | null): number | null {
  if (value === null || !/^\d{1,4}$/u.test(value)) return null;
  return clampSidebarWidth(Number.parseInt(value, 10));
}

/** The stored width: this window's own value, else the last one of any window; default 288 px. */
export function readSidebarWidth(): number {
  return (
    parseWidth(readStorage('session', STORAGE_KEYS.sidebarWidth)) ??
    parseWidth(readStorage('local', STORAGE_KEYS.sidebarWidth)) ??
    SIDEBAR_DEFAULT_WIDTH
  );
}

let width = readSidebarWidth();

export function sidebarWidth(): number {
  return width;
}

/** Sets and remembers the width (clamped; errors of the storage are swallowed). */
export function setSidebarWidth(next: number): void {
  const clamped = clampSidebarWidth(next);
  const value = String(clamped);
  writeStorage('session', STORAGE_KEYS.sidebarWidth, value);
  writeStorage('local', STORAGE_KEYS.sidebarWidth, value);
  if (width === clamped) return;
  width = clamped;
  notify();
}

/** The remembered width of the expanded sidebar. */
export function useSidebarWidth(): number {
  return useSyncExternalStore(subscribeCollapsed, sidebarWidth, sidebarWidth);
}

/** Tests: read the stored choice and width again. */
export function resetSidebarLayout(): void {
  const next = readSidebarCollapsed();
  const nextWidth = readSidebarWidth();
  if (collapsed === next && width === nextWidth) return;
  collapsed = next;
  width = nextWidth;
  notify();
}
