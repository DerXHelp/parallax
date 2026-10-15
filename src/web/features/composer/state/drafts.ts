import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { LIMITS } from '@shared/common';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';

/**
 * Composer drafts per session (Plan B "Entwürfe", R1W-21): the text of every composer lives here
 * and in localStorage under `parallax.composer.draft.<sessionKey>` – written on every change, so a
 * reload (new build id) or a remount keeps it. The decision bar reads it for "Keep planning with
 * feedback". Never part of the client store (feature state, architecture §2.4).
 */

interface DraftState {
  drafts: Readonly<Record<string, string>>;
}

const store = createStore<DraftState>(() => ({ drafts: {} }));

export function draftStorageKey(sessionKey: string): string {
  return storageKey('composer', 'draft', sessionKey);
}

/** Stored text (bounded; storage is a convenience, never trusted for more than a string). */
function loadDraft(sessionKey: string): string {
  const stored = readStorage('local', draftStorageKey(sessionKey));
  return stored === null ? '' : stored.slice(0, LIMITS.promptChars + 1);
}

/** Current draft of a session (loads it from localStorage on first use). */
export function getDraft(sessionKey: string): string {
  const current = store.getState().drafts[sessionKey];
  if (current !== undefined) return current;
  const loaded = loadDraft(sessionKey);
  store.setState((state) => ({ drafts: { ...state.drafts, [sessionKey]: loaded } }));
  return loaded;
}

export function setDraft(sessionKey: string, text: string): void {
  if (store.getState().drafts[sessionKey] === text) return;
  store.setState((state) => ({ drafts: { ...state.drafts, [sessionKey]: text } }));
  writeStorage('local', draftStorageKey(sessionKey), text === '' ? null : text);
}

export function clearDraft(sessionKey: string): void {
  setDraft(sessionKey, '');
}

/** The draft text; re-renders on changes (first render loads it from localStorage). */
export function useDraft(sessionKey: string): string {
  return useStore(store, (state) => state.drafts[sessionKey] ?? loadDraftOnce(sessionKey));
}

/** Selector fallback: reads localStorage without writing the store during render. */
const peeked = new Map<string, string>();
function loadDraftOnce(sessionKey: string): string {
  let text = peeked.get(sessionKey);
  if (text === undefined) {
    text = loadDraft(sessionKey);
    peeked.set(sessionKey, text);
  }
  return text;
}

/** Tests: forget the in-memory drafts (localStorage stays – that is what a remount reads). */
export function resetDraftStore(): void {
  store.setState({ drafts: {} });
  peeked.clear();
}
