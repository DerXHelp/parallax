import {
  ArchiveIcon,
  ArrowLeftIcon,
  BellDotIcon,
  LayersIcon,
  ListXIcon,
  PanelLeftCloseIcon,
  SquarePenIcon,
} from 'lucide-react';
import { useEffect, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { PRODUCT_NAME } from '@shared/product';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { focusElement, focusedElement } from '@web/lib/return-focus';
import {
  archivedOrder,
  folderGroupKey,
  groupKeysOfEntry,
  groupSessions,
  hostGroupKey,
  layoutGroupKeys,
  visibleSidebarOrder,
  type OrderedSession,
} from '@web/lib/session-order';
import { knownVersion } from '@web/lib/version';
import { useNow } from '@web/state/clock';
import {
  useHostState,
  useProfilesByHost,
  useSelectedSession,
  useSummaries,
  type SummaryEntry,
} from '@web/state/hooks';
import { useHostPathKey } from '@web/state/host-platform';
import { useHostLabels } from '@web/state/hosts';
import { clientStore } from '@web/state/store';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Kbd } from '@web/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ConnectionIndicator } from './ConnectionIndicator';
import { MultiHostIndicator } from './hosts/MultiHostIndicator';
import { AccountLimits } from './navigation/AccountLimits';
import { openArchiveCleanup } from './navigation/remove-session';
import {
  FolderGroupSection,
  GroupByControl,
  HostGroupSection,
  Rows,
  type RowContext,
} from './navigation/sidebar-groups';
import {
  pruneCollapsedGroups,
  setArchiveView,
  setGroupCollapsed,
  useArchiveView,
  useCollapsedGroups,
} from './navigation/sidebar-view';
import { NEXT_WAITING_KEYS, useNextWaiting } from './navigation/use-next-waiting';
import { useSidebarLayout } from './navigation/use-sidebar-layout';
import { openNewSession } from './NewSessionDialog';
import { SettingsMenu } from './SettingsMenu';
import { SidebarFilterBar, SidebarFilterEmpty } from './navigation/SidebarFilter';
import { useShortcut } from './shortcuts';
import { SIDEBAR_TOGGLE_KEYS } from './sidebar-layout';
import { useFeatureSlots } from './slots';

type Ordered = OrderedSession<SummaryEntry>;

/**
 * Slot `UpdateNotice` (WP-88a: "Parallax <v> available", "Ready – restart") in the head of the
 * sidebar; `compact` for the collapsed rail (SidebarFrame). The frame disappears while the slot
 * renders nothing (`empty:hidden`), so the placeholder leaves no gap.
 */
export function SidebarUpdateNotice({ compact }: { compact: boolean }) {
  const { UpdateNotice } = useFeatureSlots();
  return (
    <div
      data-slot="update-notice"
      data-compact={compact || undefined}
      className={cn('flex shrink-0 empty:hidden', compact ? 'justify-center' : 'mx-1.5 mb-1')}
    >
      <UpdateNotice compact={compact} />
    </div>
  );
}

/** Rows and group headers of the list, in order (WP-80: headers are reachable with the arrows). */
const LIST_ITEMS = '[data-session-row]:not([hidden]), [data-group-toggle]';

/** Moves the focus within the list: `delta` items, or to the first/last item (Home/End). */
function focusRow(list: HTMLElement, delta: number | 'first' | 'last'): void {
  const rows = [...list.querySelectorAll<HTMLButtonElement>(LIST_ITEMS)];
  if (rows.length === 0) return;
  // The focus may sit on a row's "…" button: count it as that row.
  const active = document.activeElement;
  const current = rows.findIndex(
    (row) =>
      row === active ||
      (row.hasAttribute('data-session-row') && (row.closest('li')?.contains(active) ?? false)),
  );
  let next: number;
  if (delta === 'first') next = 0;
  else if (delta === 'last') next = rows.length - 1;
  else next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
  rows[next]?.focus();
}

const LIST_MOVES: Readonly<Record<string, number | 'first' | 'last'>> = {
  ArrowDown: 1,
  ArrowUp: -1,
  Home: 'first',
  End: 'last',
};

/** The header of the group around `element` (its parent group's header for a header). */
function parentToggle(element: HTMLElement): HTMLButtonElement | null {
  const own = element.closest<HTMLElement>('[role="group"]');
  if (own === null) return null;
  const header = own.querySelector<HTMLButtonElement>('[data-group-toggle]');
  if (header !== element) return header;
  const outer = own.parentElement?.closest<HTMLElement>('[role="group"]') ?? null;
  return outer?.querySelector<HTMLButtonElement>('[data-group-toggle]') ?? null;
}

/**
 * WP-80 tree keys (WP-75 §4.4): Left collapses an expanded header, else goes to the parent header;
 * Right expands a collapsed header, else goes to its first entry. True when the key was used.
 */
function treeKey(list: HTMLElement, target: HTMLElement, key: string): boolean {
  const toggle = target.closest<HTMLButtonElement>('[data-group-toggle]');
  const groupKey = toggle?.dataset.groupToggle;
  const expanded = toggle?.getAttribute('aria-expanded') === 'true';
  if (key === 'ArrowLeft') {
    if (toggle !== null && groupKey !== undefined && expanded) {
      setGroupCollapsed(groupKey, true);
      return true;
    }
    const header = parentToggle(toggle ?? target);
    if (header === null) return false;
    header.focus();
    return true;
  }
  if (toggle === null || groupKey === undefined) return false;
  if (!expanded) {
    setGroupCollapsed(groupKey, false);
    return true;
  }
  const items = [...list.querySelectorAll<HTMLButtonElement>(LIST_ITEMS)];
  items[items.indexOf(toggle) + 1]?.focus();
  return true;
}

function onListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const move = LIST_MOVES[event.key];
  const tree = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  if ((move === undefined && !tree) || event.altKey || event.ctrlKey || event.metaKey) return;
  // R4W-12: keys of the row menus (portals – their React events bubble through the list) and of
  // anything that handled the key already are not list moves.
  if (event.defaultPrevented) return;
  if (!(event.target instanceof HTMLElement) || !event.currentTarget.contains(event.target)) return;
  // Not inside an inline title field.
  if (event.target instanceof HTMLInputElement) return;
  if (move === undefined) {
    if (treeKey(event.currentTarget, event.target, event.key)) event.preventDefault();
    return;
  }
  event.preventDefault();
  focusRow(event.currentTarget, move);
}

/**
 * Sidebar (Plan "Sidebar", WP-35): flat (pinned first, then waiting → activity) or grouped by
 * project folder, two-line entries, "Waiting for you (n)" and Alt+N (next waiting, cyclic), Alt+1…9
 * (n-th visible entry), archive view, subscription limits at the bottom.
 * WP-80 (WP-75 §4.4, ADR-226): with other computers "Group by" computer and/or folder, badges of
 * other computers' sessions, grey rows of unavailable computers; groups collapse (Alt+1…9 counts
 * visible rows only, Alt+N and "Waiting for you" count all and expand the target's groups).
 * WP-58 (V3-14): SidebarFrame keeps it mounted while collapsed (the shortcuts stay registered);
 * `onCollapse` adds the collapse button, `onChoose` follows a chosen row (the overlay closes).
 */
export function Sidebar({
  onCollapse,
  onChoose,
  width,
  maxWidth,
  willCollapse = false,
}: {
  /** Collapse button in the header (wide window: into the rail; narrow window: closes the overlay). */
  onCollapse?: () => void;
  /** Called after a row was chosen (click, Enter) – not for the shortcuts. */
  onChoose?: (sessionKey: string) => void;
  /** WP-90: width in screen px (SidebarFrame, WP-92 at the zoom; without it the former fixed w-72). */
  width?: number;
  /** CSS max-width, e.g. a share of the window. */
  maxWidth?: string;
  /** Dragged below the minimum: shown faded, collapses when let go. */
  willCollapse?: boolean;
} = {}) {
  const t = useT();
  const entries = useSummaries();
  const now = useNow(30_000);
  const [selected, select] = useSelectedSession();
  const hostState = useHostState();
  const profiles = useProfilesByHost();
  const archive = useArchiveView();
  const hosts = useHostLabels();
  const collapsed = useCollapsedGroups();
  const { layout, grouping, hostOrder, hasRemoteHosts, filterActive } = useSidebarLayout(entries, now);
  const pathKey = useHostPathKey();

  const archived: Ordered[] = useMemo(() => archivedOrder(entries, new Date(now)), [entries, now]);
  const mainOrder = layout.order;
  const shownOrder = useMemo(() => visibleSidebarOrder(layout, collapsed), [layout, collapsed]);
  const visible = archive ? archived : shownOrder;
  const { count: waitingCount, goToNext: goToNextWaiting } = useNextWaiting(layout);

  // WP-75 §4.4: collapsed groups that no longer exist are dropped – once every computer's list is
  // there (else a group of a computer still loading would lose its state).
  const allLoaded = useStore(clientStore, (state) =>
    hostOrder.every((hostId) => state.hosts[hostId]?.summariesLoaded === true),
  );
  useEffect(() => {
    if (!allLoaded) return;
    const folders = groupSessions(entries, new Date(now), pathKey).map(folderGroupKey);
    pruneCollapsedGroups([...hostOrder.map(hostGroupKey), ...folders]);
  }, [allLoaded, entries, hostOrder, now, pathKey]);

  // V3-14: the last archived session was restored (or deleted) – back to the sessions instead of
  // an empty "Archive (0)"; a focus that went down with the row moves to the list.
  const archiveEmpty = archive && archived.length === 0;
  useEffect(() => {
    if (!archiveEmpty) return;
    const lost = focusedElement() === null;
    setArchiveView(false);
    if (lost) {
      setTimeout(() => {
        if (focusedElement() === null) {
          focusElement(document.querySelector<HTMLElement>('[data-session-row][tabindex="0"]'));
        }
      }, 0);
    }
  }, [archiveEmpty]);

  useShortcut({
    id: 'shell.selectSession',
    keys: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9'],
    displayKeys: 'Alt+1–9',
    description: 'shell.shortcuts.selectSession',
    allowInInputs: true,
    run: (_event, index) => {
      const target = visible[index];
      if (target === undefined) return false;
      select(target.entry.sessionKey);
      return true;
    },
  });

  useShortcut({
    id: 'navigation.nextWaiting',
    keys: NEXT_WAITING_KEYS,
    description: 'navigation.shortcuts.nextWaiting',
    allowInInputs: true,
    run: goToNextWaiting,
  });

  // The selected row is the tab stop; without a visible selection the first row; without a visible
  // row the first group header (WP-80: every group collapsed).
  const tabStopKey = visible.some((item) => item.entry.sessionKey === selected)
    ? selected
    : (visible[0]?.entry.sessionKey ?? null);
  const groupKeys = useMemo(() => layoutGroupKeys(layout), [layout]);
  const selectedEntry = mainOrder.find((item) => item.entry.sessionKey === selected)?.entry ?? null;
  const selectedGroups = useMemo(
    () => new Set(selectedEntry === null ? [] : groupKeysOfEntry(layout, selectedEntry)),
    [layout, selectedEntry],
  );
  const context: RowContext = {
    now,
    selected,
    tabStopKey,
    tabStopGroup: tabStopKey === null && !archive ? (groupKeys[0] ?? null) : null,
    profiles,
    hosts,
    rowBadges: hasRemoteHosts && !grouping.byHost,
    folderBadges: hasRemoteHosts && !grouping.byHost,
    collapsed,
    selectedGroups,
    requiredCli: knownVersion(hostState?.sdkClaudeCodeVersion ?? null),
    onSelect:
      onChoose === undefined
        ? select
        : (sessionKey) => {
            select(sessionKey);
            onChoose(sessionKey);
          },
  };

  let list: ReactNode;
  if (archive) {
    list =
      archived.length === 0 ? (
        <p className="text-muted-foreground px-2 py-3 text-xs">{t('navigation.sidebar.archiveEmpty')}</p>
      ) : (
        <Rows items={archived} context={context} />
      );
  } else if (mainOrder.length === 0 && filterActive) {
    // WP-115: the filter hides every session – the empty state offers to clear it.
    list = <SidebarFilterEmpty />;
  } else if (mainOrder.length === 0) {
    list = <p className="text-muted-foreground px-2 py-3 text-xs">{t('shell.sidebar.empty')}</p>;
  } else if (layout.hosts !== null) {
    list = layout.hosts.map((section) => (
      <HostGroupSection key={section.key} section={section} context={context} />
    ));
  } else if (layout.folders !== null) {
    list = layout.folders.map((group) => (
      <FolderGroupSection
        key={group.key}
        group={group}
        hostId={group.sessions[0]?.entry.hostId ?? ''}
        context={context}
      />
    ));
  } else {
    list = <Rows items={layout.order} context={context} />;
  }
  let view = 'flat';
  if (archive) view = 'archive';
  else if (grouping.byHost) view = grouping.byFolder ? 'host-folder' : 'host';
  else if (grouping.byFolder) view = 'grouped';

  return (
    // w-72 by default: the two-line entries (path, branch, model, context) need the room (Plan
    // "Sidebar"); WP-90: SidebarFrame passes the width the user dragged.
    <aside
      data-will-collapse={willCollapse || undefined}
      style={width === undefined ? undefined : { width, maxWidth }}
      className={cn(
        'bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col border-r transition-opacity',
        width === undefined && 'w-72',
        willCollapse && 'opacity-60',
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
        <LayersIcon aria-hidden className="text-brand size-4" />
        <span className="font-semibold tracking-tight">{PRODUCT_NAME}</span>
        {hostState?.backend === 'fake' ? (
          // R3-02: never mistake the FakeBackend for the real claude (e.g. a forgotten fake server).
          // Without the tinted fill (V3-12): 11 px warning text reaches 4.5:1 on the light sidebar.
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning" data-slot="backend-fake" className="bg-transparent">
                {t('shell.sidebar.fakeBadge')}
                <span className="sr-only">{t('shell.sidebar.fakeHint')}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t('shell.sidebar.fakeHint')}</TooltipContent>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        {/* WP-80: "Several computers" – invisible without a role. */}
        <MultiHostIndicator />
        {/* "New session" first: it is used far more often than the grouping. */}
        <IconButton label={t('shell.sidebar.newSession')} data-action="new-session" onClick={openNewSession}>
          <SquarePenIcon aria-hidden />
        </IconButton>
        <GroupByControl grouping={grouping} hasRemoteHosts={hasRemoteHosts} />
        <SettingsMenu />
        {onCollapse === undefined ? null : (
          <IconButton
            label={t('navigation.sidebar.collapse')}
            shortcut={<Kbd>{SIDEBAR_TOGGLE_KEYS}</Kbd>}
            data-action="collapse-sidebar"
            onClick={onCollapse}
          >
            <PanelLeftCloseIcon aria-hidden />
          </IconButton>
        )}
      </div>
      {/* A row of its own: the title row of the w-72 sidebar has no room for a text button. */}
      <SidebarUpdateNotice compact={false} />
      {waitingCount > 0 ? (
        <button
          type="button"
          title={t('navigation.sidebar.nextWaiting')}
          data-action="next-waiting"
          onClick={goToNextWaiting}
          className="text-status-waiting hover:bg-sidebar-accent/70 focus-visible:ring-ring mx-1.5 mb-1 flex h-7 items-center gap-2 rounded-sm px-2 text-xs font-medium outline-none focus-visible:ring-2"
        >
          <BellDotIcon aria-hidden className="size-3.5" />
          {t('shell.sidebar.waiting', { count: waitingCount })}
        </button>
      ) : null}
      {/* WP-115: status and text filter of the list. */}
      <SidebarFilterBar />
      <nav
        aria-label={t('shell.sidebar.label')}
        data-view={view}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2"
      >
        {archive ? (
          <div className="flex h-7 items-center gap-1.5 px-1">
            <IconButton
              label={t('navigation.sidebar.archiveBack')}
              size="icon-xs"
              onClick={() => {
                setArchiveView(false);
              }}
            >
              <ArrowLeftIcon aria-hidden />
            </IconButton>
            <h2 className="text-xs font-medium">{t('navigation.sidebar.archiveTitle')}</h2>
            <span className="flex-1" />
            {/* WP-63 §1.3: remove archived sessions from Parallax (files stay). */}
            {archived.length === 0 ? null : (
              <Button
                variant="ghost"
                size="sm"
                data-action="archive-cleanup"
                className="text-muted-foreground h-6 px-1.5 text-2xs"
                onClick={openArchiveCleanup}
              >
                <ListXIcon aria-hidden />
                {t('navigation.cleanup.open')}
              </Button>
            )}
          </div>
        ) : null}
        <div onKeyDown={onListKeyDown}>{list}</div>
      </nav>
      <AccountLimits />
      <div className="border-sidebar-border flex h-8 shrink-0 items-center gap-1.5 border-t pr-2 pl-3 text-2xs whitespace-nowrap">
        <ConnectionIndicator />
        <span className="flex-1" />
        {archived.length > 0 || archive ? (
          <Button
            variant="ghost"
            size="sm"
            data-slot="archive-toggle"
            aria-pressed={archive}
            className="text-muted-foreground aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground h-6 px-1.5 text-2xs"
            onClick={() => {
              setArchiveView(!archive);
            }}
          >
            <ArchiveIcon aria-hidden />
            {t('navigation.sidebar.archive', { count: archived.length })}
          </Button>
        ) : null}
        <span className="text-muted-foreground tabular-nums">
          {t('shell.sidebar.count', { count: mainOrder.length })}
        </span>
      </div>
    </aside>
  );
}
