import { useMemo } from 'react';
import { groupKeysOfEntry, nextWaiting, type SidebarLayout } from '@web/lib/session-order';
import { useSelectedSession, type SummaryEntry } from '@web/state/hooks';
import { expandGroups, setArchiveView } from './sidebar-view';

/** Shortcut of "next waiting session" (sidebar, rail tooltip). */
export const NEXT_WAITING_KEYS = 'Alt+N';

export interface NextWaiting {
  /** Sessions that need the user (every session of the layout, collapsed groups too). */
  count: number;
  /** Selects the next one after the current; false without one. */
  goToNext: () => boolean;
}

/**
 * "Waiting for you" of the sidebar, the rail (WP-90) and Alt+N: leaves the archive view and opens
 * the target's groups (WP-80), so the row is visible when the sidebar is expanded.
 */
export function useNextWaiting(layout: SidebarLayout<SummaryEntry>): NextWaiting {
  const [selected, select] = useSelectedSession();
  const count = useMemo(() => layout.order.filter((item) => item.status.needsAttention).length, [layout]);
  const goToNext = (): boolean => {
    const target = nextWaiting(layout.order, selected, (entry) => entry.sessionKey);
    if (target === null) return false;
    setArchiveView(false);
    expandGroups(groupKeysOfEntry(layout, target));
    select(target.sessionKey);
    return true;
  };
  return { count, goToNext };
}
