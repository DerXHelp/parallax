import { clientStore, type ClientStore, type WindowPresence } from './store';

/**
 * Window presence for the server's notification channel choice (A.9, WP-02 §7.2): focus,
 * visibility, typing. The shown session (`viewingEntryId`) comes from the selection. Every host
 * connection sends `presence` after a change (debounced 250 ms, connection.ts).
 */

/** "Composer active within the last 5 s" (WP-02 §7.2). */
export const TYPING_WINDOW_MS = 5000;

function setPresence(store: ClientStore, patch: Partial<WindowPresence>): void {
  const current = store.getState().presence;
  const next = { ...current, ...patch };
  if (next.focused === current.focused && next.visible === current.visible && next.typing === current.typing)
    return;
  store.setState({ presence: next });
}

/** Tracks focus and visibility of the window; returns the cleanup. */
export function startPresenceTracking(store: ClientStore = clientStore, win: Window = window): () => void {
  const doc = win.document;
  const update = () => {
    setPresence(store, { focused: doc.hasFocus(), visible: doc.visibilityState === 'visible' });
  };
  win.addEventListener('focus', update);
  win.addEventListener('blur', update);
  doc.addEventListener('visibilitychange', update);
  update();
  return () => {
    win.removeEventListener('focus', update);
    win.removeEventListener('blur', update);
    doc.removeEventListener('visibilitychange', update);
  };
}

let typingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * For the composer (WP-16): call on input; `typing` stays true for 5 s after the last call. The
 * server uses it to avoid stealing focus with notifications.
 */
export function reportTyping(store: ClientStore = clientStore): void {
  setPresence(store, { typing: true });
  if (typingTimer !== null) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typingTimer = null;
    setPresence(store, { typing: false });
  }, TYPING_WINDOW_MS);
}
