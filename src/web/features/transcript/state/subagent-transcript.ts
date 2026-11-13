import { useCallback, useEffect, useRef, useState } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { SUBAGENT_TRANSCRIPT_LIMITS } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { hasMoreAfter, mergeSubagentPage, pollOffset, type SubagentPages } from '../lib/subagent-pages';

/** Pause between two reads while the agent runs (WP-69 §1.2: ≈ 1.5 s). */
export const SUBAGENT_POLL_MS = 1_500;
/** Items per read (the server's maximum). */
export const SUBAGENT_PAGE_ITEMS = SUBAGENT_TRANSCRIPT_LIMITS.maxPageItems;

export interface SubagentTranscriptState {
  /** The loaded window; null until the first answer. */
  pages: SubagentPages | null;
  /** The last read failed (polling has stopped until `retry`). */
  error: ErrorPayload | null;
  loadingEarlier: boolean;
  /** Loads the page before the window. */
  loadEarlier: () => void;
  /** Reads again now (after an error, or "Refresh" of a finished agent). */
  refresh: () => void;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Reads a flag ref anew after an `await` (a plain `ref.current` check stays narrowed). */
function isSet(ref: { readonly current: boolean }): boolean {
  return ref.current;
}

/**
 * The transcript of one subagent for the side panel (WP-69): read on mount (the tail), then every
 * `SUBAGENT_POLL_MS` while the server says the agent runs – only from the first item that can still
 * change (`pollOffset`). Polling stops when the panel unmounts (tab closed or switched), when the
 * agent has ended (`running` false – that answer is the last read), while the window is hidden
 * (one read as soon as it is visible again) and after an error (shown by the panel; `refresh`
 * starts again). One read at a time; answers after unmount are dropped.
 */
export function useSubagentTranscript(
  sessionKey: string,
  agentId: string,
  pollMs: number = SUBAGENT_POLL_MS,
): SubagentTranscriptState {
  const [pages, setPages] = useState<SubagentPages | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const pagesRef = useRef<SubagentPages | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const failedRef = useRef(false);
  const mountedRef = useRef(true);
  /** The current `read` for the poll timer (it schedules itself). */
  const readRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const entryId = parseSessionKey(sessionKey)?.entryId ?? null;

  const apply = useCallback((next: SubagentPages) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const read = useCallback(async (): Promise<void> => {
    if (entryId === null || busyRef.current || !mountedRef.current) return;
    busyRef.current = true;
    clearTimer();
    const current = pagesRef.current;
    let again = false;
    try {
      const page = await sendCommand(sessionKey, {
        name: 'session.subagentTranscript',
        entryId,
        agentId,
        conversationId: null,
        offset: current === null ? null : pollOffset(current),
        limit: SUBAGENT_PAGE_ITEMS,
      });
      if (!isSet(mountedRef)) return;
      const next = mergeSubagentPage(pagesRef.current, page);
      apply(next);
      failedRef.current = false;
      setError(null);
      again = next.running || hasMoreAfter(next);
    } catch (caught) {
      if (!isSet(mountedRef)) return;
      failedRef.current = true;
      setError(errorPayloadOf(caught));
    } finally {
      busyRef.current = false;
    }
    if (!again || !isSet(mountedRef) || isHidden()) return;
    const behind = pagesRef.current !== null && hasMoreAfter(pagesRef.current);
    timerRef.current = setTimeout(
      () => {
        timerRef.current = null;
        void readRef.current();
      },
      behind ? 0 : pollMs,
    );
  }, [agentId, apply, clearTimer, entryId, pollMs, sessionKey]);

  useEffect(() => {
    readRef.current = read;
  }, [read]);

  useEffect(() => {
    mountedRef.current = true;
    void read();
    const onVisibility = () => {
      if (isHidden()) {
        clearTimer();
        return;
      }
      const known = pagesRef.current;
      if (!failedRef.current && timerRef.current === null && (known === null || known.running)) void read();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mountedRef.current = false;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [clearTimer, read]);

  const refresh = useCallback(() => {
    failedRef.current = false;
    setError(null);
    void read();
  }, [read]);

  const loadEarlier = useCallback(() => {
    const current = pagesRef.current;
    if (entryId === null || current === null || current.offset === 0 || loadingEarlier) return;
    const from = Math.max(0, current.offset - SUBAGENT_PAGE_ITEMS);
    setLoadingEarlier(true);
    sendCommand(sessionKey, {
      name: 'session.subagentTranscript',
      entryId,
      agentId,
      conversationId: null,
      offset: from,
      limit: current.offset - from,
    })
      .then((page) => {
        if (!mountedRef.current) return;
        apply(mergeSubagentPage(pagesRef.current, page));
        setError(null);
      })
      .catch((caught: unknown) => {
        if (mountedRef.current) setError(errorPayloadOf(caught));
      })
      .finally(() => {
        if (mountedRef.current) setLoadingEarlier(false);
      });
  }, [agentId, apply, entryId, loadingEarlier, sessionKey]);

  return { pages, error, loadingEarlier, loadEarlier, refresh };
}
