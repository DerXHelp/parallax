import { useSyncExternalStore } from 'react';

/**
 * WP-66 "Quick question…" (sidebar context menu and the row's "…" menu): which session's popover is
 * open – window-local and module-level like `remove-session.ts`, so every menu opens the one popover
 * that NavigationLayer mounts (a lazy chunk, `QuickAskPopover.tsx`). `request` counts the openings:
 * a second "Quick question…" on the same session starts a fresh popover.
 */
export interface QuickAskState {
  sessionKey: string;
  request: number;
}

let state: QuickAskState | null = null;
let requests = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): QuickAskState | null => state;

export function openQuickAsk(sessionKey: string): void {
  state = { sessionKey, request: ++requests };
  emit();
}

export function closeQuickAsk(): void {
  if (state === null) return;
  state = null;
  emit();
}

export function useQuickAsk(): QuickAskState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
