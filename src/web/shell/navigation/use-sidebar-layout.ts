import { useMemo } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import {
  sidebarFilterActive,
  sidebarLayout,
  type SidebarFilter,
  type SidebarGrouping,
  type SidebarLayout,
} from '@web/lib/session-order';
import type { SummaryEntry } from '@web/state/hooks';
import { useHostPathKey } from '@web/state/host-platform';
import { useRemoteHosts } from '@web/state/hosts';
import { effectiveGrouping, useSidebarFilter, useSidebarGrouping } from './sidebar-view';

export interface SidebarLayoutView {
  /** WP-115: only the entries the filter keeps (`layout.unfiltered` = all, while a filter is active). */
  layout: SidebarLayout<SummaryEntry>;
  /** The grouping in effect ("by computer" only while other computers are part of the window). */
  grouping: SidebarGrouping;
  /** This computer first, then the computers of the list (fixed order, WP-75 §4.4). */
  hostOrder: readonly string[];
  /** Other computers are part of the window (badge and "Group by computer" only then). */
  hasRemoteHosts: boolean;
  /** WP-115: the filter of this window and whether it narrows the list. */
  filter: SidebarFilter;
  filterActive: boolean;
}

/**
 * The sidebar layout of this window (WP-80): one source for the sidebar (Alt+1…9, groups) and the
 * collapsed rail (same order). WP-115: the filter of the sidebar applies to both – the rail shows
 * what the sidebar lists (with its own hint that a filter is active, `RailFilterIndicator`).
 */
export function useSidebarLayout(entries: readonly SummaryEntry[], now: number): SidebarLayoutView {
  const stored = useSidebarGrouping();
  const filter = useSidebarFilter();
  const remoteHosts = useRemoteHosts();
  const hasRemoteHosts = remoteHosts.length > 0;
  const grouping = useMemo(() => effectiveGrouping(stored, hasRemoteHosts), [stored, hasRemoteHosts]);
  const hostOrder = useMemo(() => [LOCAL_HOST_ID, ...remoteHosts.map((host) => host.hostId)], [remoteHosts]);
  const pathKey = useHostPathKey();
  const layout = useMemo(
    () => sidebarLayout(entries, new Date(now), grouping, hostOrder, pathKey, filter),
    [entries, now, grouping, hostOrder, pathKey, filter],
  );
  return { layout, grouping, hostOrder, hasRemoteHosts, filter, filterActive: sidebarFilterActive(filter) };
}
