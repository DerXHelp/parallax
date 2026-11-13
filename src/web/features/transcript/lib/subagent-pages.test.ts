import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/model';
import { sampleItems } from '@shared/samples';
import { hasMoreAfter, mergeSubagentPage, pollOffset, type SubagentPages } from './subagent-pages';

/** Item n of the agent's list (order n + 1, like the server). */
function text(n: number): TranscriptItem {
  return sampleItems.assistantText({ id: `m${String(n)}:0`, messageId: `m${String(n)}`, order: n + 1, text: `t${String(n)}` });
}
function call(n: number, status: 'running' | 'done' = 'running'): TranscriptItem {
  return sampleItems.toolCall({ id: `m${String(n)}:1`, messageId: `m${String(n)}`, order: n + 1, status });
}
const page = (items: TranscriptItem[], offset: number, total: number, running = true) => ({
  items,
  offset,
  total,
  running,
});

describe('subagent pages (WP-69)', () => {
  it('the first page is the window; a poll appends and replaces by id; ids in order', () => {
    const first = mergeSubagentPage(null, page([text(0), call(1)], 0, 2));
    expect(first).toEqual({ items: [text(0), call(1)], offset: 0, total: 2, running: true });
    // The call is still open: the next poll starts there.
    expect(pollOffset(first)).toBe(1);
    const next = mergeSubagentPage(first, page([call(1, 'done'), text(2)], 1, 3, false));
    expect(next.items).toEqual([text(0), call(1, 'done'), text(2)]);
    expect(next).toMatchObject({ offset: 0, total: 3, running: false });
    expect(pollOffset(next)).toBe(3);
    expect(hasMoreAfter(next)).toBe(false);
  });

  it('an empty poll keeps the object; a longer list than one page → more after the window', () => {
    const pages: SubagentPages = { items: [text(0)], offset: 0, total: 1, running: true };
    expect(mergeSubagentPage(pages, page([], 1, 1))).toBe(pages);
    const longer = mergeSubagentPage(pages, page([text(1)], 1, 5));
    expect(hasMoreAfter(longer)).toBe(true);
    expect(pollOffset(longer)).toBe(2);
  });

  it('earlier entries are prepended; a shorter list or a gap starts over with the page', () => {
    const tail: SubagentPages = { items: [text(3), text(4)], offset: 3, total: 5, running: false };
    const earlier = mergeSubagentPage(tail, page([text(0), text(1), text(2)], 0, 5, false));
    expect(earlier.items.map((item) => item.id)).toEqual(['m0:0', 'm1:0', 'm2:0', 'm3:0', 'm4:0']);
    expect(earlier.offset).toBe(0);
    expect(mergeSubagentPage(tail, page([text(0)], 0, 1, false))).toEqual({
      items: [text(0)],
      offset: 0,
      total: 1,
      running: false,
    });
    expect(mergeSubagentPage(tail, page([text(9)], 9, 10)).offset).toBe(9);
  });
});
