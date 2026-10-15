import type { SessionSummary } from '@shared/model';
import { deriveDisplayStatus, type DisplayStatus } from '@shared/status';
import { sessionTitle } from './session-title';

/**
 * Sidebar order (Plan "Kleinkram": flat, "waiting for you" first, then activity): by the contract's
 * `sortBucket` (0 attention … 4 rest), then newest activity, then title. Archived entries are
 * left out unless `includeArchived`.
 */
export interface OrderedSession<T> {
  entry: T;
  status: DisplayStatus;
}

export function orderSessions<T extends { summary: SessionSummary }>(
  entries: readonly T[],
  now: Date,
  options: { includeArchived?: boolean } = {},
): OrderedSession<T>[] {
  return entries
    .filter((entry) => options.includeArchived === true || !entry.summary.archived)
    .map((entry) => ({ entry, status: deriveDisplayStatus(entry.summary.status, now) }))
    .sort((a, b) => {
      if (a.status.sortBucket !== b.status.sortBucket) return a.status.sortBucket - b.status.sortBucket;
      const activity =
        Date.parse(b.entry.summary.lastActivityAt) - Date.parse(a.entry.summary.lastActivityAt);
      if (activity !== 0) return activity;
      return sessionTitle(a.entry.summary).localeCompare(sessionTitle(b.entry.summary));
    });
}
