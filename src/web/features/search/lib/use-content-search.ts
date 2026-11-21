import { useEffect, useMemo, useState } from 'react';
import { LIMITS, LOCAL_HOST_ID, type HostId } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { SearchHit } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { useHostStates } from '@web/state/hooks';
import { canSendTo, sendHostCommand, useHostLabels } from '@web/state/hosts';
import { mergeHostHits, type HostHit } from './results';

/**
 * The query side of the full-text search (WP-115, ADR-255): which computers search contents, and
 * one `search.query` per computer for the current text and switches – debounced, the answers mixed
 * by time. A newer query of this window ends the older one on the server with
 * `SEARCH_FAILED {superseded}`: ignored silently (the newer answer follows).
 */

/** Pause after the last keystroke before the query is sent. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface SearchQuery {
  /** Trimmed by the hook; shorter than `LIMITS.searchTextMin` = no query. */
  text: string;
  includeArchived: boolean;
  includeToolOutput: boolean;
}

export type HostAnswer =
  | { state: 'loading' }
  | { state: 'done'; hits: readonly SearchHit[]; truncated: boolean }
  | { state: 'failed'; error: ErrorPayload };

export interface ContentSearch {
  /** `idle`: text too short or no computer searches; `loading`: some answer of the query is missing. */
  phase: 'idle' | 'loading' | 'done';
  /** Hits of every computer, newest first (while a new query runs: those of the previous one). */
  hits: readonly HostHit[];
  /** The hits shown belong to an older query (the new answers are on their way). */
  stale: boolean;
  /** Some computer had more than `LIMITS.searchHitsMax` hits. */
  truncated: boolean;
  /** Computers whose query failed (not `superseded`), in host order. */
  failures: readonly { hostId: HostId; error: ErrorPayload }[];
}

function isSuperseded(error: ErrorPayload): boolean {
  return error.code === 'SEARCH_FAILED' && error.params.reason === 'superseded';
}

/**
 * The computers to ask, this one first, then the others in display order: `HostState.features.search`
 * and, for another computer, an open connection that may send `search.query` (ADR-208).
 */
export function useSearchHosts(): readonly HostId[] {
  const states = useHostStates();
  const labels = useHostLabels();
  return useMemo(() => {
    const result: HostId[] = [];
    if (states[LOCAL_HOST_ID]?.features.search === true) result.push(LOCAL_HOST_ID);
    for (const label of labels.list) {
      if (label.availability !== 'available') continue;
      if (states[label.hostId]?.features.search !== true) continue;
      if (canSendTo(label.hostId, 'search.query')) result.push(label.hostId);
    }
    return result;
  }, [states, labels]);
}

interface Answers {
  /** The query these answers belong to. */
  key: string;
  byHost: ReadonlyMap<HostId, HostAnswer>;
}

const NO_HITS: readonly HostHit[] = Object.freeze([]);

/**
 * Runs the query `delayMs` after its last change (0: at once – opening with a text, a switch) on
 * every computer of `hosts`; a change of text, switches or computers starts a new one. CR7 (code
 * review WP-117): only a change of the computers' ids counts – `hosts` is a new array with every
 * HostState change, which must not restart (and supersede) the running query.
 */
export function useContentSearch(
  query: SearchQuery,
  hosts: readonly HostId[],
  delayMs: number = SEARCH_DEBOUNCE_MS,
): ContentSearch {
  const text = query.text.trim().slice(0, LIMITS.searchTextMax);
  const { includeArchived, includeToolOutput } = query;
  // Host ids never contain a line break (`hostIdSchema`).
  const hostsKey = hosts.join('\n');
  const stableHosts = useMemo(
    (): readonly HostId[] => (hostsKey === '' ? [] : hostsKey.split('\n')),
    [hostsKey],
  );
  const active = text.length >= LIMITS.searchTextMin && stableHosts.length > 0;
  const key = active ? JSON.stringify([text, includeArchived, includeToolOutput, stableHosts]) : '';
  const [answers, setAnswers] = useState<Answers | null>(null);

  useEffect(() => {
    if (key === '') return undefined;
    let current = true;
    const record = (hostId: HostId, answer: HostAnswer) => {
      if (!current) return;
      setAnswers((previous) => {
        const byHost = new Map(previous?.key === key ? previous.byHost : []);
        byHost.set(hostId, answer);
        return { key, byHost };
      });
    };
    const timer = setTimeout(() => {
      for (const hostId of stableHosts) {
        sendHostCommand(hostId, { name: 'search.query', text, includeArchived, includeToolOutput }).then(
          (result) => {
            record(hostId, { state: 'done', hits: result.hits, truncated: result.truncated });
          },
          (error: unknown) => {
            const payload = errorPayloadOf(error);
            if (!isSuperseded(payload)) record(hostId, { state: 'failed', error: payload });
          },
        );
      }
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key, text, includeArchived, includeToolOutput, stableHosts, delayMs]);

  return useMemo((): ContentSearch => {
    if (key === '' || answers === null) {
      return {
        phase: key === '' ? 'idle' : 'loading',
        hits: NO_HITS,
        stale: false,
        truncated: false,
        failures: [],
      };
    }
    const fresh = answers.key === key;
    const done = new Map<HostId, readonly SearchHit[]>();
    const failures: { hostId: HostId; error: ErrorPayload }[] = [];
    let truncated = false;
    for (const hostId of stableHosts) {
      const answer = answers.byHost.get(hostId);
      if (answer?.state === 'done') {
        done.set(hostId, answer.hits);
        truncated ||= answer.truncated;
      } else if (answer?.state === 'failed' && fresh) {
        failures.push({ hostId, error: answer.error });
      }
    }
    const complete = fresh && stableHosts.every((hostId) => answers.byHost.has(hostId));
    return {
      phase: complete ? 'done' : 'loading',
      hits: mergeHostHits(done, stableHosts),
      stale: !fresh,
      truncated,
      failures,
    };
  }, [answers, stableHosts, key]);
}
