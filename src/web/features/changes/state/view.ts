import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { GitDiffScope } from '@shared/model';

/**
 * View state of the tab "Changes" per session (WP-113): the compared scope, the filter "only files of
 * this session", which file diffs are open and the files picked for a commit. Global per window like
 * the side panel state, so it survives switching tabs or sessions (the data itself reloads on open).
 */

export interface ChangesView {
  scope: GitDiffScope;
  /** Only used without a worktree (with one the diff is the session's by construction). */
  onlySessionFiles: boolean;
  /** Path → open (true) or closed (false); absent = the default (open while the list is short). */
  expanded: Readonly<Record<string, boolean>>;
  /** Paths picked for "Commit selected" (repository-relative, as git names them). */
  selected: readonly string[];
}

export const DEFAULT_CHANGES_VIEW: ChangesView = Object.freeze({
  scope: 'session',
  onlySessionFiles: true,
  expanded: Object.freeze({}),
  selected: Object.freeze([]),
});

/** File diffs open by default while the list has at most this many files. */
export const EXPAND_ALL_MAX_FILES = 10;

const store = createStore<{ views: Readonly<Record<string, ChangesView>> }>(() => ({ views: {} }));

function update(sessionKey: string, change: (view: ChangesView) => Partial<ChangesView>): void {
  store.setState((state) => {
    const current = state.views[sessionKey] ?? DEFAULT_CHANGES_VIEW;
    return { views: { ...state.views, [sessionKey]: { ...current, ...change(current) } } };
  });
}

export function useChangesView(sessionKey: string): ChangesView {
  return useStore(store, (state) => state.views[sessionKey] ?? DEFAULT_CHANGES_VIEW);
}

export function setChangesScope(sessionKey: string, scope: GitDiffScope): void {
  update(sessionKey, () => ({ scope }));
}

export function setOnlySessionFiles(sessionKey: string, onlySessionFiles: boolean): void {
  update(sessionKey, () => ({ onlySessionFiles }));
}

export function setFileExpanded(sessionKey: string, path: string, open: boolean): void {
  update(sessionKey, (view) => ({ expanded: { ...view.expanded, [path]: open } }));
}

export function isFileExpanded(view: ChangesView, path: string, fileCount: number): boolean {
  return view.expanded[path] ?? fileCount <= EXPAND_ALL_MAX_FILES;
}

export function setFileSelected(sessionKey: string, path: string, picked: boolean): void {
  update(sessionKey, (view) => {
    const rest = view.selected.filter((entry) => entry !== path);
    return { selected: picked ? [...rest, path] : rest };
  });
}

export function clearSelection(sessionKey: string): void {
  update(sessionKey, () => ({ selected: [] }));
}

/** Tests: forget every view. */
export function resetChangesViews(): void {
  store.setState({ views: {} });
}
