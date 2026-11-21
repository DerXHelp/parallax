import { useMemo } from 'react';
import { groupKeysOfEntry, nextWaiting, type SidebarLayout } from '@web/lib/session-order';
import { useSelectedSession, type SummaryEntry } from '@web/state/hooks';
import { clearSidebarFilter, expandGroups, setArchiveView } from './sidebar-view';

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
 * the target's groups (WP-80), so the row is visible when the sidebar is expanded. WP-115: counts
 * and jumps over every session, also those the sidebar filter hides (`layout.unfiltered`) – a
 * session that needs the user is never filtered away; when the target is hidden, the filter is
 * reset (like the archive view is left).
 */
export function useNextWaiting(layout: SidebarLayout<SummaryEntry>): NextWaiting {
  const [selected, select] = useSelectedSession();
  const full = layout.unfiltered ?? layout;
  const count = useMemo(() => full.order.filter((item) => item.status.needsAttention).length, [full]);
  const goToNext = (): boolean => {
    const target = nextWaiting(full.order, selected, (entry) => entry.sessionKey);
    if (target === null) return false;
    setArchiveView(false);
    if (!layout.order.some((item) => item.entry === target)) clearSidebarFilter();
    expandGroups(groupKeysOfEntry(full, target));
    select(target.sessionKey);
    return true;
  };
  return { count, goToNext };
}
