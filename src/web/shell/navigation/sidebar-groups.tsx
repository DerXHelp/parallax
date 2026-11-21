import {
  BellDotIcon,
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderTreeIcon,
  MonitorIcon,
  PlusIcon,
} from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { HOST_BG } from '@web/lib/host-colors';
import {
  folderGroupKey,
  waitingCount,
  type HostSection,
  type OrderedSession,
  type SessionGroup,
  type SidebarGrouping,
} from '@web/lib/session-order';
import type { ProfilesByHost, SummaryEntry } from '@web/state/hooks';
import type { HostLabels } from '@web/state/hosts';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@web/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { Toggle } from '@web/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { HostBadge } from '../hosts/HostBadge';
import { openNewSession } from '../NewSessionDialog';
import { PathTail } from './PathTail';
import { setProjectMuted, useProjectMute } from './project-mute';
import { newSessionIn } from './session-actions';
import { SessionRow } from './SessionRow';
import { setGroupCollapsed, setSidebarGrouping } from './sidebar-view';

/**
 * Blocks of the sidebar (WP-35, WP-80 – WP-75 §4.4, ADR-226): the rows, the folder groups and the
 * computer groups with their collapsible headers, and the "Group by" control. Headers are buttons
 * with `aria-expanded` (`data-group-toggle` = collapse key), reachable with the arrow keys of the
 * list (Sidebar.tsx); only the list's tab stop is in the tab order.
 */

type Ordered = OrderedSession<SummaryEntry>;

export interface RowContext {
  now: number;
  selected: string | null;
  tabStopKey: string | null;
  /** Without a visible row: the header that takes the list's tab stop. */
  tabStopGroup: string | null;
  profiles: ProfilesByHost;
  requiredCli: string | null;
  onSelect: (sessionKey: string) => void;
  /** WP-80: names, colors and states of the other computers. */
  hosts: HostLabels;
  /** WP-80: badges on the rows of other computers (other computers present, not grouped by computer). */
  rowBadges: boolean;
  /** WP-80: badge in folder headers (other computers present, grouped by folder only). */
  folderBadges: boolean;
  collapsed: ReadonlySet<string>;
  /** Collapse keys of the groups holding the selected session (marked while collapsed). */
  selectedGroups: ReadonlySet<string>;
}

export function Rows({
  items,
  context,
  showPath = true,
}: {
  items: readonly Ordered[];
  context: RowContext;
  showPath?: boolean;
}) {
  return (
    // One column that may shrink below the titles' width: long titles get an ellipsis,
    // time and unread dot stay visible, no horizontal scrollbar (V1-03).
    <ul role="list" className="grid grid-cols-[minmax(0,1fr)] gap-px">
      {items.map(({ entry, status }) => {
        const profile = context.profiles.get(entry.hostId, entry.summary.profileId);
        const host = entry.hostId === LOCAL_HOST_ID ? undefined : context.hosts.get(entry.hostId);
        return (
          <SessionRow
            key={entry.sessionKey}
            entry={entry}
            statusKind={status.kind}
            unread={status.unread}
            now={context.now}
            selected={entry.sessionKey === context.selected}
            tabStop={entry.sessionKey === context.tabStopKey}
            profileColor={profile?.color ?? null}
            profileName={profile?.name ?? null}
            profileEffort={profile?.defaults.effort ?? null}
            requiredCli={context.requiredCli}
            showPath={showPath}
            onSelect={context.onSelect}
            hostName={host?.name ?? null}
            hostColor={host?.color ?? null}
            hostAvailability={host?.availability ?? 'available'}
            showHostBadge={context.rowBadges}
          />
        );
      })}
    </ul>
  );
}

/** Chevron of a collapsible header (points right when collapsed). */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        'size-3 shrink-0 transition-transform motion-reduce:transition-none',
        expanded && 'rotate-90',
      )}
    />
  );
}

/** Counter "n waiting" of a header (only when something waits). */
function WaitingCount({ count }: { count: number }) {
  const t = useT();
  if (count === 0) return null;
  return (
    <span
      data-slot="group-waiting"
      className="text-status-waiting flex shrink-0 items-center gap-0.5 tabular-nums"
    >
      <BellDotIcon aria-hidden className="size-3" />
      <span aria-hidden>{count}</span>
      <span className="sr-only">{t('hosts.group.waiting', { count })}</span>
    </span>
  );
}

/** Marker of a collapsed header that holds the selected session. */
function SelectedInside() {
  const t = useT();
  return (
    <span data-slot="group-selected" className="bg-brand size-1.5 shrink-0 rounded-full">
      <span className="sr-only">{t('hosts.group.selectedInside')}</span>
    </span>
  );
}

const TOGGLE_CLASSES =
  'focus-visible:ring-ring hover:bg-sidebar-accent/70 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2';

/**
 * WP-115: the muted symbol of a project header (the color never stands alone: sr-only text).
 */
function MutedMarker() {
  const t = useT();
  return (
    <span data-slot="group-muted" className="flex shrink-0 items-center">
      <BellOffIcon aria-hidden className="size-3" />
      <span className="sr-only">{t('navigation.mute.muted')}</span>
    </span>
  );
}

/**
 * A folder group: collapsible header with the folder (full path in the tooltip), count, waiting
 * (collapsed), the computer's badge (grouped by folder only, with other computers), "+" and the
 * context menu "New session in this project…" – on the group's computer. The "+" is no tab stop
 * (R4W-13: the list stays one tab stop). WP-115: worktree sessions sit in the group of their main
 * repository; the context menu mutes or unmutes the project's notifications on its computer
 * (`project-mute.ts`, only with `features.overview` and the right to change its settings), a bell
 * symbol marks a muted project.
 */
export function FolderGroupSection({
  group,
  hostId,
  context,
}: {
  group: SessionGroup<SummaryEntry>;
  hostId: string;
  context: RowContext;
}) {
  const t = useT();
  const labelId = useId();
  const listId = useId();
  const key = folderGroupKey(group);
  const collapsed = context.collapsed.has(key);
  const groupName = t('navigation.sidebar.group', { name: group.cwd });
  const host = hostId === LOCAL_HOST_ID ? undefined : context.hosts.get(hostId);
  const mute = useProjectMute(hostId, group.cwd);
  const newHere = () => {
    newSessionIn(group.cwd, hostId);
  };
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-group={group.key}
      data-collapsed={collapsed || undefined}
      className="grid gap-px pb-1.5"
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="text-muted-foreground flex h-6 min-w-0 items-center gap-1 pr-1 pl-0.5 text-2xs font-medium">
            <button
              type="button"
              data-group-toggle={key}
              aria-expanded={!collapsed}
              aria-controls={collapsed ? undefined : listId}
              tabIndex={context.tabStopGroup === key ? 0 : -1}
              className={cn(TOGGLE_CLASSES, 'h-6 pl-1')}
              onClick={() => {
                setGroupCollapsed(key, !collapsed);
              }}
            >
              <Chevron expanded={!collapsed} />
              <FolderIcon aria-hidden className="size-3 shrink-0" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex min-w-0 flex-1">
                    <span id={labelId} className="flex min-w-0">
                      <span className="sr-only">{groupName}</span>
                      {/* WP41-02: the project folder (last segment) stays visible, the parent shrinks. */}
                      <PathTail aria-hidden path={group.cwd} />
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" align="start">
                  <span className="font-mono break-all">{group.cwd}</span>
                </TooltipContent>
              </Tooltip>
              {context.folderBadges && host !== undefined ? (
                <HostBadge name={host.name} color={host.color} availability={host.availability} />
              ) : null}
              {mute.muted ? <MutedMarker /> : null}
              <span className="shrink-0 tabular-nums" aria-hidden>
                {group.sessions.length}
              </span>
              <span className="sr-only">{t('hosts.group.count', { count: group.sessions.length })}</span>
              {collapsed ? <WaitingCount count={waitingCount(group.sessions)} /> : null}
              {collapsed && context.selectedGroups.has(key) ? <SelectedInside /> : null}
            </button>
            <IconButton
              label={t('navigation.actions.newSessionHere')}
              size="icon-xs"
              tabIndex={-1}
              data-action="new-session-here"
              onClick={newHere}
            >
              <PlusIcon aria-hidden />
            </IconButton>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={groupName}>
          <ContextMenuItem onSelect={newHere}>
            <PlusIcon aria-hidden />
            {t('navigation.actions.newSessionHere')}
          </ContextMenuItem>
          {mute.available ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                data-action="mute-project"
                data-muted={mute.muted || undefined}
                onSelect={() => {
                  setProjectMuted(hostId, group.cwd, !mute.muted);
                }}
              >
                {mute.muted ? <BellIcon aria-hidden /> : <BellOffIcon aria-hidden />}
                {t(mute.muted ? 'navigation.mute.unmute' : 'navigation.mute.mute')}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {collapsed ? null : (
        <div id={listId}>
          <Rows items={group.sessions} context={context} showPath={false} />
        </div>
      )}
    </div>
  );
}

/**
 * A computer group (grouped by computer): collapsible header with name, color, connection status
 * (when it cannot be used), count, waiting and "+" (new session on this computer); inside flat or
 * the computer's folder groups.
 */
export function HostGroupSection({
  section,
  context,
}: {
  section: HostSection<SummaryEntry>;
  context: RowContext;
}) {
  const t = useT();
  const labelId = useId();
  const listId = useId();
  const local = section.hostId === LOCAL_HOST_ID;
  const host = local ? undefined : context.hosts.get(section.hostId);
  const name = local ? t('hosts.thisComputer') : (host?.name ?? section.hostId);
  const availability = host?.availability ?? 'available';
  const collapsed = context.collapsed.has(section.key);
  const count = section.sessions.length;

  let content: ReactNode;
  if (count === 0)
    content = <p className="text-muted-foreground px-2 py-1 text-2xs">{t('hosts.group.empty')}</p>;
  else if (section.folders === null) content = <Rows items={section.sessions} context={context} />;
  else {
    content = section.folders.map((group) => (
      <FolderGroupSection key={group.key} group={group} hostId={section.hostId} context={context} />
    ));
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-host-group={section.hostId}
      data-availability={availability}
      data-collapsed={collapsed || undefined}
      className="grid gap-px pb-2"
    >
      <div className="flex h-7 min-w-0 items-center gap-1 pr-1 text-xs font-medium">
        <button
          type="button"
          data-group-toggle={section.key}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : listId}
          tabIndex={context.tabStopGroup === section.key ? 0 : -1}
          className={cn(TOGGLE_CLASSES, 'h-7 pl-1')}
          onClick={() => {
            setGroupCollapsed(section.key, !collapsed);
          }}
        >
          <Chevron expanded={!collapsed} />
          {host === undefined ? (
            <MonitorIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', HOST_BG[host.color])} />
          )}
          <span id={labelId} className="min-w-0 truncate">
            <span className="sr-only">{t('hosts.group.label', { name })}</span>
            <span aria-hidden>{name}</span>
          </span>
          {availability === 'available' ? null : (
            <span data-slot="group-status" className="text-warning shrink-0 truncate text-2xs font-normal">
              {t(`hosts.status.${availability}`)}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-muted-foreground shrink-0 text-2xs tabular-nums" aria-hidden>
            {count}
          </span>
          <span className="sr-only">{t('hosts.group.count', { count })}</span>
          <WaitingCount count={section.waiting} />
          {collapsed && context.selectedGroups.has(section.key) ? <SelectedInside /> : null}
        </button>
        <IconButton
          label={t('hosts.group.newSession', { name })}
          size="icon-xs"
          tabIndex={-1}
          data-action="new-session-on-host"
          disabled={availability !== 'available'}
          onClick={() => {
            openNewSession({ hostId: section.hostId });
          }}
        >
          <PlusIcon aria-hidden />
        </IconButton>
      </div>
      {collapsed ? null : (
        <div id={listId} className="grid gap-px">
          {content}
        </div>
      )}
    </div>
  );
}

/**
 * The grouping control of the sidebar head: without other computers the toggle "Group by project"
 * of WP-35 (unchanged look); with other computers the menu "Group by" with the checkboxes Computer
 * and Folder (ADR-226). `data-slot="sidebar-mode"` either way.
 */
export function GroupByControl({
  grouping,
  hasRemoteHosts,
}: {
  grouping: SidebarGrouping;
  hasRemoteHosts: boolean;
}) {
  const t = useT();
  if (!hasRemoteHosts) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Toggle
            size="sm"
            data-slot="sidebar-mode"
            aria-label={t('navigation.sidebar.grouped')}
            pressed={grouping.byFolder}
            onPressedChange={(pressed) => {
              setSidebarGrouping({ byFolder: pressed });
            }}
          >
            <FolderTreeIcon aria-hidden />
          </Toggle>
        </TooltipTrigger>
        <TooltipContent>
          {t(grouping.byFolder ? 'navigation.sidebar.flat' : 'navigation.sidebar.grouped')}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={t('hosts.groupBy.label')}
          data-slot="sidebar-mode"
          data-grouped={grouping.byHost || grouping.byFolder || undefined}
          className="data-grouped:bg-sidebar-accent"
        >
          <FolderTreeIcon aria-hidden />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('hosts.groupBy.label')}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          data-group-by="host"
          checked={grouping.byHost}
          onCheckedChange={(checked) => {
            setSidebarGrouping({ byHost: checked });
          }}
        >
          {t('hosts.groupBy.host')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          data-group-by="folder"
          checked={grouping.byFolder}
          onCheckedChange={(checked) => {
            setSidebarGrouping({ byFolder: checked });
          }}
        >
          {t('hosts.groupBy.folder')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
