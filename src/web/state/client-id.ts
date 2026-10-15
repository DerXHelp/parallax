import { clientIdSchema, type ClientId } from '@shared/common';
import { newClientId } from '@web/lib/ids';
import { STORAGE_KEYS, readStorage, writeStorage } from '@web/lib/storage';

let cached: ClientId | null = null;

/**
 * Stable id of this window (`clientHello.clientId`, `decision.resolved.byClientId`): kept in
 * sessionStorage, so a reload keeps it and a new app window gets a new one. Note: "duplicate tab"
 * copies sessionStorage – such a twin shares the id (harmless for presence, A.9).
 */
export function getWindowClientId(): ClientId {
  if (cached !== null) return cached;
  const stored = readStorage('session', STORAGE_KEYS.clientId);
  if (stored !== null && clientIdSchema.safeParse(stored).success) {
    cached = stored;
    return stored;
  }
  const id = newClientId();
  writeStorage('session', STORAGE_KEYS.clientId, id);
  cached = id;
  return id;
}

/** Minimum time between two automatic reloads after a new build id (WP-02 §7.1: loop guard). */
export const RELOAD_GUARD_MS = 30_000;

export interface ReloadGuard {
  /** Epoch ms of the last automatic reload of this window, or null. */
  read(): number | null;
  write(at: number): void;
}

/** Reload guard in sessionStorage (survives the reload itself). */
export const sessionReloadGuard: ReloadGuard = {
  read() {
    const value = Number(readStorage('session', STORAGE_KEYS.reloadAt));
    return Number.isFinite(value) && value > 0 ? value : null;
  },
  write(at) {
    writeStorage('session', STORAGE_KEYS.reloadAt, String(at));
  },
};
