import { z } from 'zod';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { LIMITS } from '@shared/common';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';
import { activePastes, expandPastes, type DraftPaste } from '../lib/pastes';

/**
 * Composer drafts per session (Plan B "Entwürfe", R1W-21): the text of every composer lives here
 * and in localStorage under `parallax.composer.draft.<sessionKey>` – written on every change, so a
 * reload (new build id) or a remount keeps it. Never part of the client store (feature state,
 * architecture §2.4).
 *
 * Paste chips (WP-57): the field text ("input") may hold paste tokens; their texts are kept next
 * to it (`parallax.composer.pastes.<sessionKey>`, JSON, written when the pastes change). A paste
 * whose token was deleted stays until the draft is cleared or a new paste comes (so undo brings
 * the token back with its text) but no longer counts. `getDraft`/`useDraft` give the draft as it
 * would be sent (tokens replaced) – the decision bar reads it for "Keep planning with feedback";
 * the composer works on the input (`getDraftInput`/`useDraftInput`).
 */

interface DraftState {
  drafts: Readonly<Record<string, string>>;
  pastes: Readonly<Record<string, readonly DraftPaste[]>>;
}

const store = createStore<DraftState>(() => ({ drafts: {}, pastes: {} }));
const NO_PASTES: readonly DraftPaste[] = Object.freeze([]);

export function draftStorageKey(sessionKey: string): string {
  return storageKey('composer', 'draft', sessionKey);
}

export function pastesStorageKey(sessionKey: string): string {
  return storageKey('composer', 'pastes', sessionKey);
}

/** Stored pastes (storage is a convenience: anything unexpected reads as none). */
const storedPastesSchema = z
  .array(
    z.object({
      id: z.number().int().positive(),
      token: z.string().min(1).max(200),
      text: z.string().min(1).max(LIMITS.promptChars),
    }),
  )
  .max(LIMITS.pastesMax);

/** Stored text (bounded; storage is a convenience, never trusted for more than a string). */
function loadDraft(sessionKey: string): string {
  const stored = readStorage('local', draftStorageKey(sessionKey));
  return stored === null ? '' : stored.slice(0, LIMITS.promptChars + 1);
}

/** Stored pastes whose token is still in the stored text. */
function loadPastes(sessionKey: string, text: string): readonly DraftPaste[] {
  const stored = readStorage('local', pastesStorageKey(sessionKey));
  if (stored === null) return NO_PASTES;
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  } catch {
    return NO_PASTES;
  }
  const parsed = storedPastesSchema.safeParse(raw);
  if (!parsed.success) return NO_PASTES;
  const active = activePastes(text, parsed.data);
  return active.length === 0 ? NO_PASTES : active;
}

function writePastes(sessionKey: string, pastes: readonly DraftPaste[]): void {
  writeStorage('local', pastesStorageKey(sessionKey), pastes.length === 0 ? null : JSON.stringify(pastes));
}

/** Loads text and pastes of a session into the store on first use. */
function ensureLoaded(sessionKey: string): void {
  const state = store.getState();
  if (state.drafts[sessionKey] !== undefined) return;
  const text = loadDraft(sessionKey);
  const pastes = loadPastes(sessionKey, text);
  store.setState((current) => ({
    drafts: { ...current.drafts, [sessionKey]: text },
    pastes: { ...current.pastes, [sessionKey]: pastes },
  }));
}

/** The field text of a session, paste tokens included (loads it from localStorage on first use). */
export function getDraftInput(sessionKey: string): string {
  ensureLoaded(sessionKey);
  return store.getState().drafts[sessionKey] ?? '';
}

/** Every paste kept for the draft (also ones whose token was deleted – see `activePastes`). */
export function getPastes(sessionKey: string): readonly DraftPaste[] {
  ensureLoaded(sessionKey);
  return store.getState().pastes[sessionKey] ?? NO_PASTES;
}

/** The draft as it would be sent: paste tokens replaced by their texts. */
export function getDraft(sessionKey: string): string {
  return expandPastes(getDraftInput(sessionKey), getPastes(sessionKey)).text;
}

/**
 * Sets the field text; with `pastes` also the kept pastes (an empty text drops them all).
 * Writes localStorage (the pastes only when they change).
 */
export function setDraft(sessionKey: string, text: string, pastes?: readonly DraftPaste[]): void {
  ensureLoaded(sessionKey);
  const state = store.getState();
  const currentPastes = state.pastes[sessionKey] ?? NO_PASTES;
  const nextPastes = text === '' ? NO_PASTES : (pastes ?? currentPastes);
  const textChanged = state.drafts[sessionKey] !== text;
  const pastesChanged = nextPastes !== currentPastes;
  if (!textChanged && !pastesChanged) return;
  store.setState((current) => ({
    drafts: { ...current.drafts, [sessionKey]: text },
    pastes: { ...current.pastes, [sessionKey]: nextPastes },
  }));
  if (textChanged) writeStorage('local', draftStorageKey(sessionKey), text === '' ? null : text);
  if (pastesChanged) writePastes(sessionKey, nextPastes);
}

export function clearDraft(sessionKey: string): void {
  setDraft(sessionKey, '');
}

/** Selector fallback: reads localStorage without writing the store during render. */
const peeked = new Map<string, { text: string; pastes: readonly DraftPaste[] }>();
function peek(sessionKey: string): { text: string; pastes: readonly DraftPaste[] } {
  let entry = peeked.get(sessionKey);
  if (entry === undefined) {
    const text = loadDraft(sessionKey);
    entry = { text, pastes: loadPastes(sessionKey, text) };
    peeked.set(sessionKey, entry);
  }
  return entry;
}

function inputOf(state: DraftState, sessionKey: string): string {
  return state.drafts[sessionKey] ?? peek(sessionKey).text;
}

function pastesOf(state: DraftState, sessionKey: string): readonly DraftPaste[] {
  return state.drafts[sessionKey] === undefined
    ? peek(sessionKey).pastes
    : (state.pastes[sessionKey] ?? NO_PASTES);
}

/** The field text; re-renders on changes (first render loads it from localStorage). */
export function useDraftInput(sessionKey: string): string {
  return useStore(store, (state) => inputOf(state, sessionKey));
}

/** The kept pastes of the draft; re-renders on changes. */
export function usePastes(sessionKey: string): readonly DraftPaste[] {
  return useStore(store, (state) => pastesOf(state, sessionKey));
}

/** The draft as it would be sent (tokens replaced); re-renders on changes. */
export function useDraft(sessionKey: string): string {
  return useStore(
    store,
    (state) => expandPastes(inputOf(state, sessionKey), pastesOf(state, sessionKey)).text,
  );
}

/** Tests: forget the in-memory drafts (localStorage stays – that is what a remount reads). */
export function resetDraftStore(): void {
  store.setState({ drafts: {}, pastes: {} });
  peeked.clear();
}
