import { useSyncExternalStore } from 'react';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';
import type { NotificationPermissionState } from './channel';
import { getSystemNotifier } from './system';

/**
 * Notification permission for the UI (hint banner, settings menu): reactive, re-read when the
 * window gets the focus again (the user may have changed it in the Edge site settings) and after
 * a request. The hint "Enable notifications" can be dismissed per browser profile (localStorage).
 */

const HINT_KEY = storageKey('notifications', 'permissionHint');
const DISMISSED = 'dismissed';

const listeners = new Set<() => void>();
/** Fallback when localStorage is not usable: dismissed for this page only. */
let dismissedInMemory = false;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('focus', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('focus', listener);
  };
}

export function getNotificationPermission(): NotificationPermissionState {
  return getSystemNotifier().permission();
}

export function useNotificationPermission(): NotificationPermissionState {
  return useSyncExternalStore(subscribe, getNotificationPermission, getNotificationPermission);
}

/** Asks the browser – call only from a click handler. Resolves with the new permission. */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const result = await getSystemNotifier().requestPermission();
  emit();
  return result;
}

/** Re-reads the permission (tests; the hooks also re-read on window focus). */
export function refreshNotificationPermission(): void {
  emit();
}

export function isNotificationHintDismissed(): boolean {
  return dismissedInMemory || readStorage('local', HINT_KEY) === DISMISSED;
}

export function useNotificationHintDismissed(): boolean {
  return useSyncExternalStore(subscribe, isNotificationHintDismissed, isNotificationHintDismissed);
}

/** "Not now": the banner stays away (the settings menu still offers the permission). */
export function dismissNotificationHint(): void {
  dismissedInMemory = true;
  writeStorage('local', HINT_KEY, DISMISSED);
  emit();
}

/** Tests: forget the dismissal. */
export function resetNotificationHint(): void {
  dismissedInMemory = false;
  writeStorage('local', HINT_KEY, null);
  emit();
}
