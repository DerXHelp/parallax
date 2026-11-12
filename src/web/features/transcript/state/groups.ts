import { useCallback, useSyncExternalStore } from 'react';

/**
 * Open step groups of the compact transcript per session (WP-63 §1.5). Outside the components like
 * `expansion.ts`: the virtualized list unmounts rows that scroll away, and the list itself needs
 * the set to build its rows (an open group is followed by its steps). Keyed by the group's first
 * item (`groupKey`), so a group stays open while it grows. Default: closed.
 */

const EMPTY: ReadonlySet<string> = new Set();
/** At most this many open groups per session (the oldest choice goes first). */
const MAX_OPEN_PER_SESSION = 500;

const open = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();

function emit(sessionKey: string): void {
  for (const listener of [...(listeners.get(sessionKey) ?? [])]) listener();
}

export function openGroups(sessionKey: string): ReadonlySet<string> {
  return open.get(sessionKey) ?? EMPTY;
}

export function setGroupOpen(sessionKey: string, groupKey: string, value: boolean): void {
  const current = openGroups(sessionKey);
  if (current.has(groupKey) === value) return;
  const next = new Set(current);
  if (value) {
    next.add(groupKey);
    if (next.size > MAX_OPEN_PER_SESSION) {
      const oldest = next.values().next().value;
      if (oldest !== undefined) next.delete(oldest);
    }
  } else next.delete(groupKey);
  if (next.size === 0) open.delete(sessionKey);
  else open.set(sessionKey, next);
  emit(sessionKey);
}

function subscribe(sessionKey: string, listener: () => void): () => void {
  let set = listeners.get(sessionKey);
  if (set === undefined) {
    set = new Set();
    listeners.set(sessionKey, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionKey);
  };
}

/** The open group keys of a session (a new set on every change). */
export function useOpenGroups(sessionKey: string): ReadonlySet<string> {
  const subscribeKey = useCallback((listener: () => void) => subscribe(sessionKey, listener), [sessionKey]);
  const snapshot = useCallback(() => openGroups(sessionKey), [sessionKey]);
  return useSyncExternalStore(subscribeKey, snapshot, snapshot);
}

/** Tests only: every group closed. */
export function resetGroups(): void {
  const keys = [...open.keys()];
  open.clear();
  for (const key of keys) emit(key);
}
