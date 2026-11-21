import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { LIMITS, parseSessionKey } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useShellRequestHandler } from '@web/shell/requests';
import { loadEarlier } from '@web/state/actions';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionSelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';

/**
 * The jump to a search hit (WP-115, shell request `revealItem`): the transcript of that session takes
 * the request (also before its view arrived – it waits for it), finds the item in the current
 * conversation – loading earlier items with `loadEarlier` while it is further back, at most
 * `REVEAL_LOAD_ROUNDS` times –, scrolls its row into view and marks it for `REVEAL_MARK_MS`. A hit in
 * another conversation (or still not loaded) comes as an excerpt instead: the items around it from
 * `transcript.loadAround`, shown above the list. `itemId: null` (title, plan, turn summary) = only the
 * session, nothing to scroll.
 */

export const REVEAL_MARK_MS = 2000;
export const REVEAL_LOAD_ROUNDS = 10;
/** Items before and after the hit in the excerpt. */
export const REVEAL_AROUND = 3;

interface Pending {
  n: number;
  conversationId: string | null;
  itemId: string;
  /** `loadEarlier` calls so far. */
  rounds: number;
}

type Location =
  | { status: 'idle' }
  | { status: 'found'; anchor: string }
  /** Not loaded, earlier items exist (`oldest`: order of the oldest loaded – changes per load). */
  | { status: 'earlier'; oldest: number }
  | { status: 'elsewhere' };

const IDLE: Location = Object.freeze({ status: 'idle' });
const ELSEWHERE: Location = Object.freeze({ status: 'elsewhere' });

export interface RevealExcerpt {
  n: number;
  itemId: string;
  /** The hit belongs to another conversation than the current one. */
  otherConversation: boolean;
  items: readonly TranscriptItem[];
}

export interface RevealHandle {
  /** The top-level item whose row is marked now (null: none). */
  marked: string | null;
  excerpt: RevealExcerpt | null;
  closeExcerpt: () => void;
}

interface ItemIndex {
  byId: ReadonlyMap<string, TranscriptItem>;
  byToolUseId: ReadonlyMap<string, TranscriptItem>;
}

const indexCache = new WeakMap<readonly TranscriptItem[], ItemIndex>();

function itemIndex(items: readonly TranscriptItem[]): ItemIndex {
  const cached = indexCache.get(items);
  if (cached !== undefined) return cached;
  const byId = new Map<string, TranscriptItem>();
  const byToolUseId = new Map<string, TranscriptItem>();
  for (const item of items) {
    byId.set(item.id, item);
    if (item.kind === 'tool_call') byToolUseId.set(item.toolUseId, item);
  }
  const index = { byId, byToolUseId };
  indexCache.set(items, index);
  return index;
}

/**
 * Where the item is in the view: its top-level row (a subagent item → the Agent card that holds it),
 * further back, or not in this conversation / not loadable.
 */
export function locateItem(view: SessionViewState, conversationId: string | null, itemId: string): Location {
  if (conversationId !== null && view.conversationId !== conversationId) return ELSEWHERE;
  const { byId, byToolUseId } = itemIndex(view.items);
  let item = byId.get(itemId);
  if (item === undefined) {
    return view.hasEarlier ? { status: 'earlier', oldest: view.items[0]?.order ?? 0 } : ELSEWHERE;
  }
  const seen = new Set<string>();
  while (item.parentToolUseId !== null && !seen.has(item.id)) {
    seen.add(item.id);
    const parent = byToolUseId.get(item.parentToolUseId);
    if (parent === undefined) break;
    item = parent;
  }
  return { status: 'found', anchor: item.id };
}

export function useReveal({
  sessionKey,
  hasView,
  conversationId,
  scrollTo,
}: {
  sessionKey: string;
  hasView: boolean;
  /** The view's current conversation. */
  conversationId: string | null;
  /** Scrolls the row holding this top-level item into view. */
  scrollTo: (itemId: string) => void;
}): RevealHandle {
  const [pending, setPending] = useState<Pending | null>(null);
  const [excerpt, setExcerpt] = useState<RevealExcerpt | null>(null);
  const sequence = useRef(0);
  /** The request whose row was scrolled to (once per request). */
  const scrolled = useRef<number | null>(null);
  /** The request with a load in flight. */
  const busy = useRef<number | null>(null);

  useShellRequestHandler('revealItem', (request) => {
    if (request.sessionKey !== sessionKey) return false;
    sequence.current += 1;
    const n = sequence.current;
    setExcerpt(null);
    setPending(
      request.itemId === null
        ? null
        : { n, conversationId: request.conversationId, itemId: request.itemId, rounds: 0 },
    );
    return true;
  });

  const wantedConversation = pending?.conversationId ?? null;
  const wantedItem = pending?.itemId ?? null;
  const select = useCallback(
    (view: SessionViewState): Location =>
      wantedItem === null ? IDLE : locateItem(view, wantedConversation, wantedItem),
    [wantedConversation, wantedItem],
  );
  const location = useSessionSelector(sessionKey, select, IDLE);

  const scroll = useEffectEvent((itemId: string) => {
    scrollTo(itemId);
  });

  /** Ends request `n` (unless a newer one replaced it). */
  const finish = useCallback((n: number) => {
    setPending((current) => (current?.n === n ? null : current));
  }, []);

  /** Only asynchronous state changes (the answer of `transcript.loadAround`). */
  const showExcerpt = useEffectEvent((request: Pending, entryId: string, target: string) => {
    const otherConversation = target !== conversationId;
    busy.current = request.n;
    sendCommand(sessionKey, {
      name: 'transcript.loadAround',
      entryId,
      conversationId: target,
      itemId: request.itemId,
      around: REVEAL_AROUND,
    }).then(
      (result) => {
        busy.current = null;
        if (sequence.current !== request.n) return;
        setExcerpt({ n: request.n, itemId: request.itemId, otherConversation, items: result.items });
        finish(request.n);
      },
      (error: unknown) => {
        busy.current = null;
        if (sequence.current !== request.n) return;
        showErrorNotice(errorPayloadOf(error), { sessionKey, id: `transcript-reveal-${sessionKey}` });
        finish(request.n);
      },
    );
  });

  useEffect(() => {
    if (pending === null || !hasView || location.status === 'idle') return undefined;
    const { n } = pending;
    if (location.status === 'found') {
      if (scrolled.current !== n) {
        scrolled.current = n;
        scroll(location.anchor);
      }
      const timer = setTimeout(() => {
        finish(n);
      }, REVEAL_MARK_MS);
      return () => {
        clearTimeout(timer);
      };
    }
    if (busy.current === n) return undefined;
    if (location.status === 'earlier' && pending.rounds < REVEAL_LOAD_ROUNDS) {
      busy.current = n;
      loadEarlier(sessionKey, { limit: LIMITS.loadEarlierMax }).then(
        (added) => {
          busy.current = null;
          if (added)
            setPending((current) =>
              current?.n === n ? { ...current, rounds: current.rounds + 1 } : current,
            );
          else
            setPending((current) =>
              current?.n === n ? { ...current, rounds: REVEAL_LOAD_ROUNDS } : current,
            );
        },
        (error: unknown) => {
          busy.current = null;
          showErrorNotice(errorPayloadOf(error), { sessionKey, id: `transcript-reveal-${sessionKey}` });
          finish(n);
        },
      );
      return undefined;
    }
    // Not in the list: the excerpt (a hit always names its conversation; without one: the current).
    const entryId = parseSessionKey(sessionKey)?.entryId;
    const target = pending.conversationId ?? conversationId;
    if (entryId !== undefined && target !== null) showExcerpt(pending, entryId, target);
    return undefined;
  }, [pending, hasView, location, sessionKey, conversationId, finish]);

  const closeExcerpt = useCallback(() => {
    setExcerpt(null);
  }, []);

  return {
    marked: pending !== null && location.status === 'found' ? location.anchor : null,
    excerpt,
    closeExcerpt,
  };
}
