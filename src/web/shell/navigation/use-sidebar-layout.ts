import { useMemo } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import { sidebarLayout, type SidebarGrouping, type SidebarLayout } from '@web/lib/session-order';
import type { SummaryEntry } from '@web/state/hooks';
import { useRemoteHosts } from '@web/state/hosts';
import { effectiveGrouping, useSidebarGrouping } from './sidebar-view';

export interface SidebarLayoutView {
  layout: SidebarLayout<SummaryEntry>;
  /** The grouping in effect ("by computer" only while other computers are part of the window). */
  grouping: SidebarGrouping;
  /** This computer first, then the computers of the list (fixed order, WP-75 §4.4). */
  hostOrder: readonly string[];
  /** Other computers are part of the window (badge and "Group by computer" only then). */
  hasRemoteHosts: boolean;
}

/**
 * The sidebar layout of this window (WP-80): one source for the sidebar (Alt+1…9, groups) and the
 * collapsed rail (same order).
 */
export function useSidebarLayout(entries: readonly SummaryEntry[], now: number): SidebarLayoutView {
  const stored = useSidebarGrouping();
  const remoteHosts = useRemoteHosts();
  const hasRemoteHosts = remoteHosts.length > 0;
  const grouping = useMemo(() => effectiveGrouping(stored, hasRemoteHosts), [stored, hasRemoteHosts]);
  const hostOrder = useMemo(() => [LOCAL_HOST_ID, ...remoteHosts.map((host) => host.hostId)], [remoteHosts]);
  const layout = useMemo(
    () => sidebarLayout(entries, new Date(now), grouping, hostOrder),
    [entries, now, grouping, hostOrder],
  );
  return { layout, grouping, hostOrder, hasRemoteHosts };
}
