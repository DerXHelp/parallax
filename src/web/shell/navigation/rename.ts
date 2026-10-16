import { useEffect, useSyncExternalStore } from 'react';

/**
 * Inline title edit (Plan "/rename": double click on the title in the sidebar or the header, F2,
 * `/rename` without an argument via the request `renameTitle`). At most one edit per window; the
 * place decides where the field appears. The header of a shown session wins over its sidebar row.
 */
export type RenamePlace = 'sidebar' | 'header';

interface RenameState {
  sessionKey: string;
  place: RenamePlace;
}

let current: RenameState | null = null;
/** Element focused when the edit started (focus returns there after Enter/Esc). */
let returnFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();
/** Session keys whose header is mounted (counted: panes may show a session twice). */
const headers = new Map<string, number>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The place an edit of this session opens at: its header if one is mounted, else its sidebar row. */
export function renamePlaceFor(sessionKey: string): RenamePlace {
  return (headers.get(sessionKey) ?? 0) > 0 ? 'header' : 'sidebar';
}

/** Starts the edit (replacing another one); `place` defaults to `renamePlaceFor`. */
export function startRename(sessionKey: string, place: RenamePlace = renamePlaceFor(sessionKey)): void {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
  current = { sessionKey, place };
  emit();
}

let pending: RenameState | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * "Rename" chosen in a menu: the edit starts once the menu has closed (`takePendingRename` in the
 * menu's `onCloseAutoFocus`) – a still open menu traps the focus and would pull it out of the field.
 * Fallback after 500 ms in case the menu never reports its close.
 */
export function startRenameAfterMenu(sessionKey: string, place: RenamePlace): void {
  pending = { sessionKey, place };
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    takePendingRename();
  }, 500);
}

/** For `onCloseAutoFocus` of the session menus: starts a pending rename; true = keep the focus. */
export function takePendingRename(): boolean {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  const next = pending;
  pending = null;
  if (next === null) return false;
  startRename(next.sessionKey, next.place);
  return true;
}

/**
 * Ends the edit. With `restoreFocus` (Enter/Esc) the focus goes back to where it was, or – if that
 * element is gone (a menu item) – to the session's sidebar row or the header's "…" button.
 */
export function finishRename(restoreFocus: boolean): void {
  const ended = current;
  if (ended === null) return;
  current = null;
  const target = returnFocus;
  returnFocus = null;
  emit();
  if (!restoreFocus) return;
  // After React has re-rendered the row/title.
  setTimeout(() => {
    if (target?.isConnected === true && !target.hidden) {
      target.focus();
      return;
    }
    // Session keys are `host:en_<hex>` – safe inside a quoted attribute selector.
    const selector =
      ended.place === 'sidebar'
        ? `[data-session-row="${ended.sessionKey}"]`
        : `[data-session-key="${ended.sessionKey}"] [data-slot="session-menu"]`;
    document.querySelector<HTMLElement>(selector)?.focus();
  }, 0);
}

export function getRename(): Readonly<RenameState> | null {
  return current;
}

/** True while this session is edited at this place. */
export function useRenaming(sessionKey: string, place: RenamePlace): boolean {
  const snapshot = () => current?.sessionKey === sessionKey && current.place === place;
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The session header registers itself while mounted (edits then open there). */
export function useRenameHeader(sessionKey: string): void {
  useEffect(() => {
    headers.set(sessionKey, (headers.get(sessionKey) ?? 0) + 1);
    return () => {
      const count = (headers.get(sessionKey) ?? 1) - 1;
      if (count <= 0) headers.delete(sessionKey);
      else headers.set(sessionKey, count);
      // An edit in a header that goes away ends.
      if (current?.sessionKey === sessionKey && current.place === 'header' && count <= 0) finishRename(false);
    };
  }, [sessionKey]);
}

/** Tests. */
export function resetRename(): void {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  pending = null;
  current = null;
  returnFocus = null;
  emit();
}
