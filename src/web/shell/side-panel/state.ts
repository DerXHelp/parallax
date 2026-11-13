import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { windowsPathsEqual } from '@shared/paths';
import type { SidePanelTab } from '../requests';

/**
 * State of the side panel host (Phase 3, ADR-150): the open tab per session (absent = closed), the
 * element that opened it (focus returns there on close), the file of the viewer tab with a short
 * back stack, and which sessions have a host mounted (else a feature falls back to inline content,
 * e.g. the plan inside its card – R2W-15). Global per window like the former plan panel state, so
 * the panel survives switching sessions.
 */

/** Target of the viewer tab (request `openFile`). */
export interface SidePanelFile {
  path: string;
  line: number | null;
  col: number | null;
  /**
   * Counts repeated requests of the SAME target (path, line, col): the host remounts the viewer, so a
   * second click on the same reference jumps to the line again.
   */
  revision: number;
}

/** WP-69: target of the subagent tab (request `openSubagent`; the latest one per session). */
export interface SidePanelSubagent {
  agentId: string;
  title: string;
  subagentType: string | null;
}

/** Files kept for "Back" per session (WP-54: the last 10). */
export const SIDE_PANEL_HISTORY_MAX = 10;

interface SidePanelState {
  tabs: Readonly<Record<string, SidePanelTab>>;
  /** Last `openFile` target per session (kept while other tabs show or the panel is closed). */
  files: Readonly<Record<string, SidePanelFile>>;
  /** Back stack of the viewer tab per session, most recent first (never contains the current file). */
  history: Readonly<Record<string, readonly SidePanelFile[]>>;
  /** Mounted hosts per session (ref count). */
  mounted: Readonly<Record<string, number>>;
  /** WP-69: the subagent of the subagent tab per session (kept while other tabs show). */
  subagents: Readonly<Record<string, SidePanelSubagent>>;
}

const EMPTY_HISTORY: readonly SidePanelFile[] = Object.freeze([]);

const store = createStore<SidePanelState>(() => ({ tabs: {}, files: {}, history: {}, mounted: {}, subagents: {} }));

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

export function getSidePanelFile(sessionKey: string): SidePanelFile | null {
  return store.getState().files[sessionKey] ?? null;
}

export function useSidePanelSubagent(sessionKey: string): SidePanelSubagent | null {
  return useStore(store, (state) => state.subagents[sessionKey] ?? null);
}

export function getSidePanelSubagent(sessionKey: string): SidePanelSubagent | null {
  return store.getState().subagents[sessionKey] ?? null;
}

/** Sets the subagent of the tab `subagent` (the caller opens the tab); the same one again keeps it. */
export function setSidePanelSubagent(sessionKey: string, subagent: SidePanelSubagent): void {
  const current = store.getState().subagents[sessionKey];
  if (
    current?.agentId === subagent.agentId &&
    current.title === subagent.title &&
    current.subagentType === subagent.subagentType
  ) {
    return;
  }
  store.setState((state) => ({ subagents: { ...state.subagents, [sessionKey]: { ...subagent } } }));
}

/** Back stack of the viewer tab (most recent first). */
export function useSidePanelHistory(sessionKey: string): readonly SidePanelFile[] {
  return useStore(store, (state) => state.history[sessionKey] ?? EMPTY_HISTORY);
}

function withoutPath(list: readonly SidePanelFile[], path: string): SidePanelFile[] {
  return list.filter((entry) => !windowsPathsEqual(entry.path, path));
}

/**
 * Sets the viewer target; the caller opens the tab `file`. A different file pushes the current one
 * onto the back stack (deduplicated by path, at most SIDE_PANEL_HISTORY_MAX); the same target again
 * bumps `revision`; the same file at another line only moves the line.
 */
export function setSidePanelFile(
  sessionKey: string,
  file: { path: string; line: number | null; col: number | null },
): void {
  store.setState((state) => {
    const current = state.files[sessionKey];
    const history = state.history[sessionKey] ?? EMPTY_HISTORY;
    if (current !== undefined && windowsPathsEqual(current.path, file.path)) {
      // Same file (any spelling) at the same position: remount, so the viewer jumps again.
      const same = current.line === file.line && current.col === file.col;
      const next: SidePanelFile = { ...file, revision: same ? current.revision + 1 : current.revision };
      return { files: { ...state.files, [sessionKey]: next } };
    }
    const nextHistory =
      current === undefined
        ? withoutPath(history, file.path)
        : [current, ...withoutPath(withoutPath(history, current.path), file.path)].slice(
            0,
            SIDE_PANEL_HISTORY_MAX,
          );
    return {
      files: { ...state.files, [sessionKey]: { ...file, revision: 0 } },
      history: { ...state.history, [sessionKey]: nextHistory },
    };
  });
}

/**
 * Goes back to the entry `index` of the back stack (0 = the previous file): it becomes the viewer
 * target, it and the newer entries leave the stack (like the browser's back list). False if absent.
 */
export function goBackSidePanelFile(sessionKey: string, index = 0): boolean {
  const history = store.getState().history[sessionKey] ?? EMPTY_HISTORY;
  const target = history[index];
  if (target === undefined) return false;
  store.setState((state) => ({
    files: { ...state.files, [sessionKey]: { ...target, revision: target.revision + 1 } },
    history: { ...state.history, [sessionKey]: history.slice(index + 1) },
  }));
  return true;
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
  store.setState({ tabs: {}, files: {}, history: {}, mounted: {}, subagents: {} });
  openers.clear();
}
