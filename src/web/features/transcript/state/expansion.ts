import { useCallback, useSyncExternalStore } from 'react';

/**
 * Open/closed state of collapsible parts (tool calls, thinking, agent steps) per session and item.
 * Lives outside the components because the virtualized list unmounts rows that scroll out of
 * view – a re-mounted row keeps what the user opened or closed. Only explicit user choices are
 * stored; everything else follows the renderer's default.
 */

type Listener = () => void;

const MAX_ENTRIES = 5000;
const state = new Map<string, boolean>();
const listeners = new Map<string, Set<Listener>>();

export function expansionKey(sessionKey: string, itemId: string, part = 'main'): string {
  return `${sessionKey}\u0000${itemId}\u0000${part}`;
}

export function setExpanded(key: string, open: boolean): void {
  state.delete(key);
  state.set(key, open);
  if (state.size > MAX_ENTRIES) {
    const oldest = state.keys().next().value;
    if (oldest !== undefined) state.delete(oldest);
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

function subscribe(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (set === undefined) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** `[open, setOpen]` for one collapsible part; `defaultOpen` until the user toggles it. */
export function useExpanded(key: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const subscribeKey = useCallback((listener: Listener) => subscribe(key, listener), [key]);
  const getSnapshot = useCallback(() => state.get(key), [key]);
  const stored = useSyncExternalStore(subscribeKey, getSnapshot, getSnapshot);
  const setOpen = useCallback(
    (open: boolean) => {
      setExpanded(key, open);
    },
    [key],
  );
  return [stored ?? defaultOpen, setOpen];
}

/** Tests only: forget every stored choice. */
export function resetExpansion(): void {
  const keys = [...state.keys()];
  state.clear();
  for (const key of keys) for (const listener of listeners.get(key) ?? []) listener();
}
