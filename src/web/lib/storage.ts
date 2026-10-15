import { PRODUCT_ID } from '@shared/product';

/**
 * Safe access to localStorage/sessionStorage: both can be missing or throw (privacy settings,
 * quota). Callers get `null` instead of an exception.
 */
export type StorageArea = 'local' | 'session';

/** All keys of the shell/state (one place, prefixed with the product id). Features: `storageKey`. */
export const STORAGE_KEYS = {
  /** sessionStorage: window id (`cl_…`), stable across reloads of this window. */
  clientId: `${PRODUCT_ID}.clientId`,
  /** sessionStorage: time of the last automatic reload after a new build id (loop guard). */
  reloadAt: `${PRODUCT_ID}.reloadAt`,
  /** localStorage: last applied theme setting, so a reload starts without a flash. */
  theme: `${PRODUCT_ID}.theme`,
} as const;

/**
 * Storage key of a feature (R1W-21): `parallax.<namespace>.<part>.<part>…`, namespace = feature
 * folder. Example WP-16: `storageKey('composer', 'draft', sessionKey)` →
 * `parallax.composer.draft.local:en_…`. Parts must not be empty.
 */
export function storageKey(namespace: string, ...parts: readonly string[]): string {
  if (namespace === '' || parts.some((part) => part === '')) {
    throw new Error('storageKey: namespace and parts must not be empty');
  }
  return [PRODUCT_ID, namespace, ...parts].join('.');
}

function area(kind: StorageArea): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** True when the area exists and accepts writes (probe key, removed again). */
export function storageAvailable(kind: StorageArea): boolean {
  try {
    const storage = area(kind);
    if (storage === null) return false;
    const probe = `${PRODUCT_ID}.probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function readStorage(kind: StorageArea, key: string): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** `null` removes the key. Errors (quota, disabled storage) are swallowed. */
export function writeStorage(kind: StorageArea, key: string, value: string | null): void {
  try {
    const storage = area(kind);
    if (storage === null) return;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
}
