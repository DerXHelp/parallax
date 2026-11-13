import type { SubagentTranscriptPage, TranscriptItem } from '@shared/model';

/**
 * WP-69: the loaded part of a subagent transcript in the side panel (pure functions; the panel's
 * hook polls). The server answers pages of the agent's own list (`session.subagentTranscript`,
 * orders from 1, stable while the file grows); the panel keeps a contiguous window
 * `[offset, offset + items.length)` of it:
 * - the first read is the tail (`offset` null);
 * - a poll asks only from the first item that can still change (`pollOffset`: a tool call without
 *   its result yet) – or from the end of the window – so a long transcript is not sent again every
 *   1.5 s;
 * - "earlier entries" prepends the page before the window.
 */
export interface SubagentPages {
  items: readonly TranscriptItem[];
  /** Index of `items[0]` in the agent's list. */
  offset: number;
  total: number;
  running: boolean;
}

/** Tool-call statuses that a later read can still change (the result has not arrived). */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['streaming_input', 'pending', 'running', 'background']);

function isOpen(item: TranscriptItem): boolean {
  if (item.kind === 'tool_call') return OPEN_STATUSES.has(item.status);
  if (item.kind === 'thinking' || item.kind === 'assistant_text') return item.streaming;
  return false;
}

function byOrder(a: TranscriptItem, b: TranscriptItem): number {
  return a.order - b.order;
}

/** Where the next poll starts: the first open item of the window, else its end. */
export function pollOffset(pages: SubagentPages): number {
  const index = pages.items.findIndex(isOpen);
  return pages.offset + (index < 0 ? pages.items.length : index);
}

/** More of the list after the window than one page brought (poll again at once). */
export function hasMoreAfter(pages: SubagentPages): boolean {
  return pages.offset + pages.items.length < pages.total;
}

/**
 * A page into the window. The page replaces the items it holds (same id) and appends new ones.
 * Starts over with the page when there is nothing yet, the list got shorter (the file was
 * rewritten) or the page does not touch the window (a gap – the panel then offers the earlier
 * entries again).
 */
export function mergeSubagentPage(current: SubagentPages | null, page: SubagentTranscriptPage): SubagentPages {
  const fresh: SubagentPages = {
    items: page.items,
    offset: page.offset,
    total: page.total,
    running: page.running,
  };
  if (current === null || page.total < current.total) return fresh;
  const end = current.offset + current.items.length;
  const pageEnd = page.offset + page.items.length;
  if (page.offset > end || pageEnd < current.offset) return fresh;
  // Nothing new (a poll of a finished window): keep the object, nothing re-renders.
  if (page.items.length === 0 && page.total === current.total && page.running === current.running) return current;
  const byId = new Map<string, TranscriptItem>();
  for (const item of current.items) byId.set(item.id, item);
  for (const item of page.items) byId.set(item.id, item);
  return {
    items: [...byId.values()].sort(byOrder),
    offset: Math.min(current.offset, page.offset),
    total: page.total,
    running: page.running,
  };
}
