import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { ReviewComment } from '@shared/model';
import type { LineAnchor } from '../lib/anchor';

/**
 * The one open comment editor of the tab "Changes" per session (WP-113): a new comment at a line
 * range of a file, or the text of an existing comment. An editor with unsaved text is never replaced
 * by another one – `openReviewDraft` says no and the caller moves the focus back to it (like the plan
 * annotations, WP-93).
 */

export type ReviewDraftTarget =
  | { kind: 'new'; path: string; anchor: LineAnchor }
  | { kind: 'edit'; path: string; commentId: ReviewComment['id'] };

export interface ReviewDraft {
  target: ReviewDraftTarget;
  text: string;
  /** The text it started with (unchanged = may be replaced). */
  initial: string;
}

const store = createStore<{ drafts: Readonly<Record<string, ReviewDraft>> }>(() => ({ drafts: {} }));

export function useReviewDraft(sessionKey: string): ReviewDraft | null {
  return useStore(store, (state) => state.drafts[sessionKey] ?? null);
}

export function isDraftDirty(draft: ReviewDraft | null): boolean {
  return draft !== null && draft.text.trim() !== draft.initial.trim();
}

/** Opens an editor; false while another one holds unsaved text (it stays). */
export function openReviewDraft(sessionKey: string, target: ReviewDraftTarget, text = ''): boolean {
  if (isDraftDirty(store.getState().drafts[sessionKey] ?? null)) return false;
  store.setState((state) => ({ drafts: { ...state.drafts, [sessionKey]: { target, text, initial: text } } }));
  return true;
}

export function setReviewDraftText(sessionKey: string, text: string): void {
  store.setState((state) => {
    const draft = state.drafts[sessionKey];
    return draft === undefined ? state : { drafts: { ...state.drafts, [sessionKey]: { ...draft, text } } };
  });
}

export function closeReviewDraft(sessionKey: string): void {
  store.setState((state) => {
    if (state.drafts[sessionKey] === undefined) return state;
    const { [sessionKey]: _closed, ...rest } = state.drafts;
    return { drafts: rest };
  });
}

/** Tests: close every editor. */
export function resetReviewDrafts(): void {
  store.setState({ drafts: {} });
}
