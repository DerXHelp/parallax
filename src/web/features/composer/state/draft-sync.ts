import { useEffect } from 'react';
import { parseSessionKey, type ClientId, type EntryId } from '@shared/common';
import type { Draft, DraftInput } from '@shared/model';
import { useT } from '@web/i18n';
import { readStorage, storageKey, writeStorage } from '@web/lib/storage';
import { getWindowClientId } from '@web/state/client-id';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionConnectionStatus, useSessionSelector } from '@web/state/hooks';
import { collapsePastes, expandPastes, lineCount } from '../lib/pastes';
import { connectDraftSync, getDraftInput, getPastes, replaceDraft } from './drafts';

/**
 * WP-77 (ADR-210): the composer draft in step with the server (`session.setDraft`,
 * `detail.draft`), so another window – also on another computer – shows the same half-written text.
 *
 * - **Sending:** an edit of this window (`setDraft`/`clearDraft` in `drafts.ts`) goes out about
 *   400 ms after the last change, one command at a time: the text with the paste tokens replaced
 *   plus the paste texts (like `PromptInput.pastes`); an empty field clears the server draft.
 *   Attachments stay in the window.
 * - **Receiving:** the window's own state (same `clientId`, a `rev` the server gave it) is ignored. A
 *   draft of another window – or a cleared one – is taken over only while this window has changed
 *   nothing since its last confirmed state; the paste chips are rebuilt (`collapsePastes`). Else the
 *   own edit wins (the last writer wins on the server too).
 * - **Ack before echo:** ops are applied once per frame, the ack of the command at once – until the
 *   view shows the acknowledged state (or a newer one) an older view is not taken for a foreign one.
 * - **localStorage** stays the cache: `parallax.composer.draftSync.<sessionKey>` = `dirty` (edits not
 *   confirmed yet → sent after a reload or a reconnect) or `clean` (confirmed). Without a mark a
 *   stored draft is from before WP-77: sent once if the server has none (migration).
 * - **Errors** (offline, NOT_IMPLEMENTED of an older server, DRAFT_TOO_LARGE, …) never disturb typing:
 *   the draft stays local and goes with the next edit or reconnect; NOT_IMPLEMENTED stops sending
 *   until the next reconnect.
 */

/** Delay between the last edit and `session.setDraft`. */
export const DRAFT_SYNC_DELAY_MS = 400;

type TokenMaker = (id: number, paste: string) => string;

interface Confirmed {
  rev: number;
  clientId: ClientId | null;
}

interface SyncState {
  readonly entryId: EntryId;
  /** Edits of this window the server has not acknowledged yet. */
  dirty: boolean;
  /** Counts edits: an ack only confirms the edits it was sent with. */
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** An edit was due while a command was in flight: send again after its answer. */
  again: boolean;
  /** NOT_IMPLEMENTED (older server): nothing is sent until the next reconnect. */
  unsupported: boolean;
  /** The server state the field matches (null = no draft; undefined = not known yet). */
  confirmed: Confirmed | null | undefined;
  /** After an ack: the acknowledged state and the newest rev known then, until the view shows it. */
  awaiting: { rev: number | null; floor: number } | null;
  /** Newest rev known in this connection. */
  maxRev: number;
  /** Newest rev the server gave this window in this connection. */
  ownRev: number;
  /** The view has been looked at since the start or the last reconnect. */
  seen: boolean;
  /** Last `detail.draft` of the view (undefined = no view). */
  view: Draft | null | undefined;
  online: boolean;
  makeToken: TokenMaker | null;
}

const states = new Map<string, SyncState>();

function stateFor(sessionKey: string): SyncState | null {
  const existing = states.get(sessionKey);
  if (existing !== undefined) return existing;
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return null;
  const state: SyncState = {
    entryId: parsed.entryId,
    dirty: false,
    generation: 0,
    timer: null,
    inFlight: false,
    again: false,
    unsupported: false,
    confirmed: undefined,
    awaiting: null,
    maxRev: 0,
    ownRev: 0,
    seen: false,
    view: undefined,
    online: false,
    makeToken: null,
  };
  states.set(sessionKey, state);
  return state;
}

export function draftSyncStorageKey(sessionKey: string): string {
  return storageKey('composer', 'draftSync', sessionKey);
}

type SyncMark = 'dirty' | 'clean' | null;

function readMark(sessionKey: string): SyncMark {
  const stored = readStorage('local', draftSyncStorageKey(sessionKey));
  return stored === 'dirty' || stored === 'clean' ? stored : null;
}

/** `dirty`, or `clean` while the field holds text (an empty, confirmed field needs no mark). */
function writeMark(sessionKey: string, dirty: boolean): void {
  const value = dirty ? 'dirty' : getDraftInput(sessionKey) === '' ? null : 'clean';
  writeStorage('local', draftSyncStorageKey(sessionKey), value);
}

/** The field as the server would store it (tokens replaced); null = empty. */
function localDraft(sessionKey: string): DraftInput | null {
  const input = getDraftInput(sessionKey);
  return input === '' ? null : expandPastes(input, getPastes(sessionKey));
}

function sameContent(local: DraftInput | null, server: Draft | null): boolean {
  if (local === null || server === null) return local === server;
  return (
    local.text === server.text &&
    local.pastes.length === server.pastes.length &&
    local.pastes.every((paste, index) => paste === server.pastes[index])
  );
}

function schedule(sessionKey: string, state: SyncState): void {
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    push(sessionKey, state);
  }, DRAFT_SYNC_DELAY_MS);
}

/** Sends the field now (one command at a time; errors keep the draft local). */
function push(sessionKey: string, state: SyncState): void {
  // A state forgotten by `resetDraftStore` (tests) sends nothing any more.
  if (states.get(sessionKey) !== state) return;
  if (state.inFlight) {
    state.again = true;
    return;
  }
  if (!state.dirty || state.unsupported) return;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const generation = state.generation;
  state.inFlight = true;
  state.again = false;
  sendCommand(sessionKey, {
    name: 'session.setDraft',
    entryId: state.entryId,
    draft: localDraft(sessionKey),
    baseRev: state.confirmed?.rev ?? null,
  }).then(
    (result) => {
      state.inFlight = false;
      acknowledged(sessionKey, state, result.rev, generation);
    },
    (error: unknown) => {
      state.inFlight = false;
      if (errorPayloadOf(error).code === 'NOT_IMPLEMENTED') state.unsupported = true;
      // The draft stays local (and dirty): the next edit or reconnect sends it again.
      if (state.again) push(sessionKey, state);
    },
  );
}

function acknowledged(sessionKey: string, state: SyncState, rev: number | null, generation: number): void {
  if (states.get(sessionKey) !== state) return;
  if (rev !== null) {
    state.ownRev = Math.max(state.ownRev, rev);
    state.maxRev = Math.max(state.maxRev, rev);
  }
  state.confirmed = rev === null ? null : { rev, clientId: getWindowClientId() };
  state.awaiting = { rev, floor: rev ?? state.maxRev };
  if (state.generation === generation) {
    state.dirty = false;
    writeMark(sessionKey, false);
  }
  if (state.again) {
    push(sessionKey, state);
    return;
  }
  evaluate(sessionKey, state);
}

/** Takes the server state over (the field changed nothing since its last confirmed state). */
function adopt(sessionKey: string, state: SyncState, view: Draft | null): void {
  if (!sameContent(localDraft(sessionKey), view)) {
    if (view === null) {
      replaceDraft(sessionKey, '', []);
    } else {
      if (state.makeToken === null) return;
      const collapsed = collapsePastes(view.text, view.pastes, state.makeToken);
      replaceDraft(sessionKey, collapsed.text, collapsed.pastes);
    }
  }
  state.confirmed = view === null ? null : { rev: view.rev, clientId: view.clientId };
  writeMark(sessionKey, false);
}

/** First look at the view (start, reconnect): the localStorage mark decides. */
function firstSight(sessionKey: string, state: SyncState, view: Draft | null): void {
  const mark = readMark(sessionKey);
  if (state.dirty || mark === 'dirty') {
    state.dirty = true;
    push(sessionKey, state);
    return;
  }
  if (mark === null && view === null && getDraftInput(sessionKey) !== '') {
    // Migration: a draft stored before WP-77 goes to the server once.
    state.dirty = true;
    writeMark(sessionKey, true);
    push(sessionKey, state);
    return;
  }
  adopt(sessionKey, state, view);
}

/** Compares the view with the field (after a view change, an ack, a reconnect). */
function evaluate(sessionKey: string, state: SyncState): void {
  const view = state.view;
  if (view === undefined || state.inFlight || !state.online) return;
  const awaiting = state.awaiting;
  if (awaiting !== null) {
    const shown =
      view === null
        ? awaiting.rev === null
        : view.rev > awaiting.floor || (view.rev === awaiting.rev && view.clientId === getWindowClientId());
    // An older state is still on screen: the echo of the ack is about to come.
    if (!shown) return;
    state.awaiting = null;
  }
  if (view !== null) state.maxRev = Math.max(state.maxRev, view.rev);
  if (!state.seen) {
    state.seen = true;
    firstSight(sessionKey, state, view);
    return;
  }
  // The own edits win (they are on their way); nothing is sent from here.
  if (state.dirty) return;
  // The own state – the current one or an older one.
  if (view !== null && view.clientId === getWindowClientId() && view.rev <= state.ownRev) return;
  const confirmed = state.confirmed;
  if (
    view === null ? confirmed === null : confirmed?.rev === view.rev && confirmed.clientId === view.clientId
  ) {
    return;
  }
  adopt(sessionKey, state, view);
}

/** An edit of this window (`setDraft`/`clearDraft`). */
function edited(sessionKey: string): void {
  const state = stateFor(sessionKey);
  if (state === null) return;
  state.generation += 1;
  state.dirty = true;
  writeMark(sessionKey, true);
  schedule(sessionKey, state);
}

function connectionChanged(sessionKey: string, online: boolean): void {
  const state = stateFor(sessionKey);
  if (state === null || state.online === online) return;
  state.online = online;
  if (!online) return;
  // A (re)connect: look again as at the start; a waiting echo or a refusal is from the old one.
  state.seen = false;
  state.awaiting = null;
  state.maxRev = 0;
  state.ownRev = 0;
  state.unsupported = false;
  evaluate(sessionKey, state);
}

/** The field is gone: its next mount looks again as after a reconnect (nothing was watched). */
function detached(sessionKey: string): void {
  const state = states.get(sessionKey);
  if (state === undefined) return;
  state.online = false;
  state.view = undefined;
}

function viewChanged(sessionKey: string, view: Draft | null | undefined): void {
  const state = stateFor(sessionKey);
  if (state === null) return;
  state.view = view;
  evaluate(sessionKey, state);
}

/**
 * Keeps the draft through a prompt that is not the draft (e.g. `/compact` from the context gauge):
 * the server clears the draft a prompt was sent from unless it changed meanwhile – call this right
 * after sending, so the field goes to the server again behind the prompt.
 */
export function keepDraftThroughSend(sessionKey: string): void {
  const state = stateFor(sessionKey);
  if (state === null || getDraftInput(sessionKey) === '') return;
  state.generation += 1;
  state.dirty = true;
  writeMark(sessionKey, true);
  push(sessionKey, state);
}

/**
 * The composer field of `sessionKey` in step with the server (see above); the composer mounts it
 * once per field. Edits are sent also while it is not mounted.
 */
export function useDraftSync(sessionKey: string): void {
  const t = useT();
  const view = useSessionSelector<Draft | null | undefined>(sessionKey, (v) => v.detail.draft, undefined);
  const online = useSessionConnectionStatus(sessionKey) === 'open';
  useEffect(() => {
    const state = stateFor(sessionKey);
    if (state !== null) {
      state.makeToken = (id, paste) =>
        t('composer.pastes.token', { id: String(id), count: lineCount(paste) });
    }
  }, [sessionKey, t]);
  useEffect(() => {
    connectionChanged(sessionKey, online);
  }, [sessionKey, online]);
  useEffect(
    () => () => {
      detached(sessionKey);
    },
    [sessionKey],
  );
  useEffect(() => {
    viewChanged(sessionKey, view);
  }, [sessionKey, view]);
}

/** Tests (through `resetDraftStore`): forget every sync state (timers cleared; localStorage stays). */
function resetDraftSync(): void {
  for (const state of states.values()) if (state.timer !== null) clearTimeout(state.timer);
  states.clear();
}

connectDraftSync({ edited, reset: resetDraftSync });
