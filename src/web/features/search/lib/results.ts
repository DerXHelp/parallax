import { makeSessionKey, type HostId } from '@shared/common';
import type { SearchHit } from '@shared/model';

/**
 * Pure helpers of the full-text search (WP-115, ADR-255): the hits of several computers mixed by
 * time, grouped by session for the list, and a snippet cut into plain and marked parts.
 */

/** One hit with the computer it came from (`sessionKey` = `hostId:entryId`, client only). */
export interface HostHit {
  hostId: HostId;
  sessionKey: string;
  hit: SearchHit;
  /** Stable key of the option (DOM id, React key). */
  key: string;
}

/** The hits of one session, newest first; `latestAt` = time of the newest. */
export interface HitGroup {
  sessionKey: string;
  hostId: HostId;
  latestAt: string;
  hits: HostHit[];
  /** Index of the group's first hit in the whole list (options are numbered across the groups). */
  start: number;
}

function time(at: string): number {
  const value = Date.parse(at);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * The answers of every computer as one list, newest first (ADR-255: each computer answers newest
 * first; equal times keep the order of `hostOrder`, then the computer's own order).
 */
export function mergeHostHits(
  answers: ReadonlyMap<HostId, readonly SearchHit[]>,
  hostOrder: readonly HostId[],
): HostHit[] {
  const result: { item: HostHit; host: number; index: number }[] = [];
  const order = [...hostOrder, ...[...answers.keys()].filter((hostId) => !hostOrder.includes(hostId))];
  order.forEach((hostId, host) => {
    const hits = answers.get(hostId) ?? [];
    hits.forEach((hit, index) => {
      const sessionKey = makeSessionKey(hostId, hit.entryId);
      result.push({
        item: { hostId, sessionKey, hit, key: `${hostId}|${String(index)}` },
        host,
        index,
      });
    });
  });
  result.sort((a, b) => time(b.item.hit.at) - time(a.item.hit.at) || a.host - b.host || a.index - b.index);
  return result.map((entry) => entry.item);
}

/** Groups by session in the order of their newest hit (the input is newest first). */
export function groupHits(hits: readonly HostHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const item of hits) {
    const group = groups.get(item.sessionKey);
    if (group === undefined) {
      groups.set(item.sessionKey, {
        sessionKey: item.sessionKey,
        hostId: item.hostId,
        latestAt: item.hit.at,
        hits: [item],
        start: 0,
      });
    } else {
      group.hits.push(item);
    }
  }
  const result = [...groups.values()];
  let start = 0;
  for (const group of result) {
    group.start = start;
    start += group.hits.length;
  }
  return result;
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * The snippet as plain and marked parts: ranges are clamped to the text, sorted, and overlapping
 * or touching ones merged; empty ranges are dropped. Never HTML – the caller renders `<mark>`.
 */
export function snippetParts(snippet: string, ranges: readonly (readonly [number, number])[]): SnippetPart[] {
  const clamped = ranges
    .map(([start, end]): [number, number] => [
      Math.max(0, Math.min(start, snippet.length)),
      Math.max(0, Math.min(end, snippet.length)),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const range of clamped) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const parts: SnippetPart[] = [];
  let at = 0;
  for (const [start, end] of merged) {
    if (start > at) parts.push({ text: snippet.slice(at, start), match: false });
    parts.push({ text: snippet.slice(start, end), match: true });
    at = end;
  }
  if (at < snippet.length || parts.length === 0) parts.push({ text: snippet.slice(at), match: false });
  return parts;
}
