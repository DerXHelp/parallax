import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { SidePanelTab } from '../requests';

/**
 * State of the side panel host (Phase 3, ADR-150): the open tab per session (absent = closed), the
 * element that opened it (focus returns there on close) and which sessions have a host mounted
 * (else a feature falls back to inline content, e.g. the plan inside its card – R2W-15). Global
 * per window like the former plan panel state, so the panel survives switching sessions.
 */

/** Target of the viewer tab (request `openFile`). */
export interface SidePanelFile {
  path: string;
  line: number | null;
  col: number | null;
}

interface SidePanelState {
  tabs: Readonly<Record<string, SidePanelTab>>;
  /** Last `openFile` target per session (kept while other tabs show). */
  files: Readonly<Record<string, SidePanelFile>>;
  /** Mounted hosts per session (ref count). */
  mounted: Readonly<Record<string, number>>;
}

const store = createStore<SidePanelState>(() => ({ tabs: {}, files: {}, mounted: {} }));

/** Elements that opened the panel (focus returns there on close). */
const openers = new Map<string, HTMLElement>();

export function useSidePanelTab(sessionKey: string): SidePanelTab | null {
  return useStore(store, (state) => state.tabs[sessionKey] ?? null);
}

export function getSidePanelTab(sessionKey: string): SidePanelTab | null {
  return store.getState().tabs[sessionKey] ?? null;
}

/** Opens (or switches) the tab; `opener` gets the focus back when the panel closes. */
export function openSidePanel(sessionKey: string, tab: SidePanelTab, opener?: HTMLElement | null): void {
  if (opener !== undefined && opener !== null) openers.set(sessionKey, opener);
  if (store.getState().tabs[sessionKey] === tab) return;
  store.setState((state) => ({ tabs: { ...state.tabs, [sessionKey]: tab } }));
}

export function useSidePanelFile(sessionKey: string): SidePanelFile | null {
  return useStore(store, (state) => state.files[sessionKey] ?? null);
}

/** Sets the viewer target; the caller opens the tab `file`. */
export function setSidePanelFile(sessionKey: string, file: SidePanelFile): void {
  store.setState((state) => ({ files: { ...state.files, [sessionKey]: file } }));
}

/** Closes the panel; returns the element that opened it (if still in the document). */
export function closeSidePanel(sessionKey: string): HTMLElement | null {
  const opener = openers.get(sessionKey) ?? null;
  openers.delete(sessionKey);
  if (store.getState().tabs[sessionKey] !== undefined) {
    store.setState((state) => {
      const { [sessionKey]: _closed, ...tabs } = state.tabs;
      return { tabs };
    });
  }
  return opener?.isConnected === true ? opener : null;
}

/** Called by SidePanelHost while mounted (ref-counted); returns the unregister function. */
export function registerSidePanelHost(sessionKey: string): () => void {
  store.setState((state) => ({
    mounted: { ...state.mounted, [sessionKey]: (state.mounted[sessionKey] ?? 0) + 1 },
  }));
  return () => {
    store.setState((state) => {
      const count = (state.mounted[sessionKey] ?? 1) - 1;
      const { [sessionKey]: _previous, ...rest } = state.mounted;
      return { mounted: count <= 0 ? rest : { ...rest, [sessionKey]: count } };
    });
  };
}

export function isSidePanelHostMounted(sessionKey: string): boolean {
  return (store.getState().mounted[sessionKey] ?? 0) > 0;
}

/** Re-renders when the session's host mounts/unmounts. */
export function useSidePanelHostMounted(sessionKey: string): boolean {
  return useStore(store, (state) => (state.mounted[sessionKey] ?? 0) > 0);
}

/** Tests: forget everything (the module state is global). */
export function resetSidePanelState(): void {
  store.setState({ tabs: {}, files: {}, mounted: {} });
  openers.clear();
}
