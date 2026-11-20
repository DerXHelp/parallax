import { useEffect, useSyncExternalStore } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import { zoomSchema } from '@shared/model';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';
import { DEFAULT_ZOOM, clampZoom, rootFontSize } from '@web/lib/zoom';
import { showTextNotice } from './notices';
import { selectSettings, updateSettings } from './settings';
import { clientStore, type ClientStore } from './store';

/**
 * Zoom of the window (WP-92, ADR-233): `settings.zoom` (every window of this computer – a display
 * setting, also for the sessions of another computer, like the transcript view) becomes the root
 * font size of `<html>`; the UI is in rem, so text, spacing and icons grow with it. WP-96: the
 * setting is relative to the design's default size (`BASE_ZOOM`, 100 % → `font-size: 110%`). Layout
 * code that works in px reads the applied zoom (`useZoom`/`getZoom`, helpers in `lib/zoom.ts`).
 *
 * Ctrl+wheel and Ctrl+Plus/Minus/0 (`shell/zoom-input.ts`) go through `requestZoom`: applied at
 * once, saved once the keys rest (one `settings.update` per burst, not per wheel tick). Until that
 * save settled, the stored setting does not override the window (no jump back and forth between
 * the optimistic value and an older ack). The last applied value is cached in localStorage, so a
 * reload starts at that size (`applyInitialZoom`, main.tsx) – also as the window-local setting until
 * `host.state` arrives (ShellEffects mounts before it, it must not fall back to 100 % meanwhile).
 *
 * Known limit: a key step before the first `host.state` only changes the window-local setting and
 * gives way to the stored one when it arrives – like any setting changed before the connection.
 */

/** Delay after the last key or wheel step before the setting is saved. */
export const ZOOM_SAVE_DELAY_MS = 300;

let applied = DEFAULT_ZOOM;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Sets the root font size (always inline, also at 100 %: the base size, WP-96) and caches the value. */
export function applyZoom(percent: number, root: HTMLElement = document.documentElement): void {
  const value = clampZoom(percent);
  root.style.fontSize = rootFontSize(value);
  if (applied === value) return;
  applied = value;
  writeStorage('local', STORAGE_KEYS.zoom, String(value));
  notify();
}

export function readCachedZoom(): number | null {
  const raw = readStorage('local', STORAGE_KEYS.zoom);
  if (raw === null || !/^\d{1,3}$/u.test(raw)) return null;
  const parsed = zoomSchema.safeParse(Number.parseInt(raw, 10));
  return parsed.success ? parsed.data : null;
}

/**
 * Before the first render (main.tsx): the cached zoom or 100 % – applied and taken as the
 * window-local setting, which `useSettings` returns until `host.state` arrives.
 */
export function applyInitialZoom(win: Window = window, store: ClientStore = clientStore): number {
  const zoom = readCachedZoom() ?? DEFAULT_ZOOM;
  applyZoom(zoom, win.document.documentElement);
  const { localSettings } = store.getState();
  if (localSettings.zoom !== zoom) store.setState({ localSettings: { ...localSettings, zoom } });
  return applied;
}

/** The zoom applied to this window (percent). */
export function getZoom(): number {
  return applied;
}

export function subscribeZoom(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The applied zoom (percent); re-renders when it changes. */
export function useZoom(): number {
  return useSyncExternalStore(subscribeZoom, getZoom, getZoom);
}

let pending: { value: number; token: number } | null = null;
let lastToken = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function settle(token: number, store: ClientStore): void {
  if (pending?.token !== token) return;
  pending = null;
  applyZoom(selectSettings(store.getState(), LOCAL_HOST_ID).zoom);
}

/**
 * Key or wheel: applies `percent` at once and saves it after ZOOM_SAVE_DELAY_MS without a further
 * request. A refused save restores the stored setting and says so in the window's hint region.
 */
export function requestZoom(percent: number, store: ClientStore = clientStore): void {
  const value = clampZoom(percent);
  const token = ++lastToken;
  pending = { value, token };
  applyZoom(value);
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    updateSettings({ zoom: value }, LOCAL_HOST_ID, store).then(
      () => {
        settle(token, store);
      },
      () => {
        showTextNotice('settings.saveFailed', undefined, { tone: 'error', id: 'settings.saveFailed' });
        settle(token, store);
      },
    );
  }, ZOOM_SAVE_DELAY_MS);
}

/** ShellEffects: applies the setting, unless a change by key or wheel still waits for its save. */
export function useZoomController(zoom: number): void {
  useEffect(() => {
    if (pending === null) applyZoom(zoom);
  }, [zoom]);
}

/** Tests: back to 100 % without a pending save. */
export function resetZoomState(root: HTMLElement = document.documentElement): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  pending = null;
  applyZoom(DEFAULT_ZOOM, root);
}
