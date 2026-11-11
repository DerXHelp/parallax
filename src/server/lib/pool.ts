/**
 * Bounded parallelism (WP-53: `file.statMany` stats at most 8 paths at once, ADR-142): `mapPool`
 * runs `work` for every item with at most `limit` calls in flight and returns the results in item
 * order. `work` should not throw (wrap failures into the result); a throw rejects the whole call
 * after the running calls are done.
 */
import { toError } from './async';

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One iterator shared by all workers: each item is taken exactly once.
  const pending = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of pending) {
      results[index] = await work(item, index);
    }
  };
  const count = Math.max(1, Math.min(limit, items.length));
  const settled = await Promise.allSettled(Array.from({ length: count }, () => worker()));
  for (const outcome of settled) {
    if (outcome.status === 'rejected') throw toError(outcome.reason);
  }
  return results;
}
