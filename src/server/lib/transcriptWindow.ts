/**
 * WP-110: the window of a conversation's items around one item (`TranscriptStore.readAround`, jump to
 * a search hit). Pure; shared by the transcript store and its test doubles.
 */
import type { TranscriptItem } from '@shared/model';
import type { TranscriptWindow } from '../sync/ports';

/**
 * `items` sorted by order: the item `itemId` and up to `n` items before and after it; null = not
 * found. A negative `n` counts as 0.
 */
export function sliceAround(
  items: readonly TranscriptItem[],
  itemId: string,
  n: number,
): TranscriptWindow | null {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  const count = Math.max(0, n);
  const start = Math.max(0, index - count);
  const end = Math.min(items.length, index + count + 1);
  return { items: items.slice(start, end), hasEarlier: start > 0, hasLater: end < items.length };
}
