import { LOCAL_HOST_ID, entryIdSchema, makeSessionKey, parseSessionKey } from '@shared/common';
import { SESSION_HASH_PARAM } from '@shared/http';
import { getHashParam, setHashParam } from '@web/lib/hash';
import { clientStore, type ClientStore } from './store';

/**
 * Session shown in this window, mirrored in the URL (`#session=local:en_…`, Plan "Web-UI": a new
 * window can open with a given session). A bare entry id (`#session=en_…`) means the local host –
 * that is what the launcher opens for the protocol handler (Phase 2, `appUrlWithCode`).
 */
export { SESSION_HASH_PARAM };

/** Session key from the hash, or null if absent/invalid. */
export function sessionKeyFromHash(hash: string): string | null {
  const value = getHashParam(hash, SESSION_HASH_PARAM);
  if (typeof value !== 'string' || value === '') return null;
  if (parseSessionKey(value) !== null) return value;
  const entryId = entryIdSchema.safeParse(value);
  return entryId.success ? makeSessionKey(LOCAL_HOST_ID, entryId.data) : null;
}

/** The hash with the session parameter set (or removed for null); other parameters stay. */
export function hashWithSession(hash: string, sessionKey: string | null): string {
  return setHashParam(hash, SESSION_HASH_PARAM, sessionKey ?? undefined);
}

export interface SelectionOptions {
  store?: ClientStore;
  /** Mirror into `location.hash` via history.replaceState (default true in the browser). */
  updateHash?: boolean;
}

export function getSelectedSession(store: ClientStore = clientStore): string | null {
  return store.getState().selectedSession;
}

export function setSelectedSession(sessionKey: string | null, options: SelectionOptions = {}): void {
  const store = options.store ?? clientStore;
  if (sessionKey !== null && parseSessionKey(sessionKey) === null) return;
  if (store.getState().selectedSession !== sessionKey) store.setState({ selectedSession: sessionKey });
  if ((options.updateHash ?? true) && typeof window !== 'undefined') {
    const next = hashWithSession(window.location.hash, sessionKey);
    if (next !== window.location.hash) {
      const url = `${window.location.pathname}${window.location.search}${next}`;
      window.history.replaceState(window.history.state, '', url);
    }
  }
}

/** Reads the selection from the hash now and on every `hashchange`; returns the cleanup. */
export function startSelectionSync(store: ClientStore = clientStore, win: Window = window): () => void {
  const read = () => {
    const key = sessionKeyFromHash(win.location.hash);
    if (store.getState().selectedSession !== key) store.setState({ selectedSession: key });
  };
  read();
  win.addEventListener('hashchange', read);
  return () => {
    win.removeEventListener('hashchange', read);
  };
}
