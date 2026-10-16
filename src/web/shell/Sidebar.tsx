import {
  ArchiveIcon,
  ArrowLeftIcon,
  BellDotIcon,
  FolderIcon,
  FolderTreeIcon,
  LayersIcon,
  PlusIcon,
  SquarePenIcon,
} from 'lucide-react';
import { useId, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import type { HostId } from '@shared/common';
import type { ProfileSummary } from '@shared/model';
import { PRODUCT_NAME } from '@shared/product';
import { useT } from '@web/i18n';
import {
  archivedOrder,
  flatSidebarOrder,
  groupSessions,
  groupedOrder,
  nextWaiting,
  type OrderedSession,
  type SessionGroup,
} from '@web/lib/session-order';
import { knownVersion } from '@web/lib/version';
import { useNow } from '@web/state/clock';
import {
  useHostState,
  useHostStates,
  useSelectedSession,
  useSummaries,
  type SummaryEntry,
} from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@web/ui/context-menu';
import { IconButton } from '@web/ui/icon-button';
import { Toggle } from '@web/ui/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ConnectionIndicator } from './ConnectionIndicator';
import { AccountLimits } from './navigation/AccountLimits';
import { newSessionIn } from './navigation/session-actions';
import { SessionRow } from './navigation/SessionRow';
import { setArchiveView, setSidebarMode, useArchiveView, useSidebarMode } from './navigation/sidebar-view';
import { openNewSession } from './NewSessionDialog';
import { SettingsMenu } from './SettingsMenu';
import { useShortcut } from './shortcuts';

type Ordered = OrderedSession<SummaryEntry>;

/** Moves the focus within the list: `delta` rows, or to the first/last row (Home/End). */
function focusRow(list: HTMLElement, delta: number | 'first' | 'last'): void {
  const rows = [...list.querySelectorAll<HTMLButtonElement>('[data-session-row]:not([hidden])')];
  if (rows.length === 0) return;
  // The focus may sit on a row's "…" button: count it as that row.
  const active = document.activeElement;
  const current = rows.findIndex((row) => row === active || (row.closest('li')?.contains(active) ?? false));
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

function onListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const move = LIST_MOVES[event.key];
  if (move === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
  // Not inside an inline title field.
  if (event.target instanceof HTMLInputElement) return;
  event.preventDefault();
  focusRow(event.currentTarget, move);
}

interface RowContext {
  now: number;
  selected: string | null;
  tabStopKey: string | null;
  profiles: ReadonlyMap<string, ProfileSummary>;
  requiredCli: string | null;
  onSelect: (sessionKey: string) => void;
}

function profileKey(hostId: HostId, profileId: string): string {
  return `${hostId}|${profileId}`;
}

function Rows({
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
        const profile = context.profiles.get(profileKey(entry.hostId, entry.summary.profileId));
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
            requiredCli={context.requiredCli}
            showPath={showPath}
            onSelect={context.onSelect}
          />
        );
      })}
    </ul>
  );
}

/** A project group of the grouped view: folder label (full path in the tooltip), "+" and context menu. */
function GroupSection({ group, context }: { group: SessionGroup<SummaryEntry>; context: RowContext }) {
  const t = useT();
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} data-group={group.key} className="grid gap-px pb-1.5">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="text-muted-foreground flex h-6 min-w-0 items-center gap-1.5 pr-1 pl-2 text-2xs font-medium">
            <FolderIcon aria-hidden className="size-3 shrink-0" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 flex-1 truncate">
                  <span id={labelId}>
                    <span className="sr-only">{t('navigation.sidebar.group', { name: group.cwd })}</span>
                    <span aria-hidden>{group.label}</span>
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="right" align="start">
                <span className="font-mono break-all">{group.cwd}</span>
              </TooltipContent>
            </Tooltip>
            <span className="shrink-0 tabular-nums" aria-hidden>
              {group.sessions.length}
            </span>
            <IconButton
              label={t('navigation.actions.newSessionHere')}
              size="icon-xs"
              data-action="new-session-here"
              onClick={() => {
                newSessionIn(group.cwd);
              }}
            >
              <PlusIcon aria-hidden />
            </IconButton>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              newSessionIn(group.cwd);
            }}
          >
            <PlusIcon aria-hidden />
            {t('navigation.actions.newSessionHere')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Rows items={group.sessions} context={context} showPath={false} />
    </div>
  );
}

/**
 * Sidebar (Plan "Sidebar", WP-35): flat (pinned first, then waiting → activity) or grouped by
 * project folder, two-line entries, "Waiting for you (n)" and Alt+N (next waiting, cyclic), Alt+1…9
 * (n-th visible entry), archive view, subscription limits at the bottom.
 */
export function Sidebar() {
  const t = useT();
  const entries = useSummaries();
  const now = useNow(30_000);
  const [selected, select] = useSelectedSession();
  const hostState = useHostState();
  const hostStates = useHostStates();
  const mode = useSidebarMode();
  const archive = useArchiveView();

  const flat: Ordered[] = useMemo(() => flatSidebarOrder(entries, new Date(now)), [entries, now]);
  const groups = useMemo(
    () => (mode === 'grouped' ? groupSessions(entries, new Date(now)) : null),
    [entries, now, mode],
  );
  const archived: Ordered[] = useMemo(() => archivedOrder(entries, new Date(now)), [entries, now]);
  const mainOrder = useMemo(() => (groups === null ? flat : groupedOrder(groups)), [groups, flat]);
  const visible = archive ? archived : mainOrder;
  const waitingCount = flat.filter((item) => item.status.needsAttention).length;
  const profiles = useMemo(() => {
    const map = new Map<string, ProfileSummary>();
    for (const [hostId, state] of Object.entries(hostStates)) {
      for (const profile of state.profiles) map.set(profileKey(hostId, profile.id), profile);
    }
    return map;
  }, [hostStates]);

  const goToNextWaiting = (): boolean => {
    const target = nextWaiting(mainOrder, selected, (entry) => entry.sessionKey);
    if (target === null) return false;
    setArchiveView(false);
    select(target.sessionKey);
    return true;
  };

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
    keys: 'Alt+N',
    description: 'navigation.shortcuts.nextWaiting',
    allowInInputs: true,
    run: goToNextWaiting,
  });

  // The selected row is the tab stop; without a visible selection the first row.
  const tabStopKey = visible.some((item) => item.entry.sessionKey === selected)
    ? selected
    : (visible[0]?.entry.sessionKey ?? null);
  const context: RowContext = {
    now,
    selected,
    tabStopKey,
    profiles,
    requiredCli: knownVersion(hostState?.sdkClaudeCodeVersion ?? null),
    onSelect: select,
  };

  let list: ReactNode;
  if (archive) {
    list =
      archived.length === 0 ? (
        <p className="text-muted-foreground px-2 py-3 text-xs">{t('navigation.sidebar.archiveEmpty')}</p>
      ) : (
        <Rows items={archived} context={context} />
      );
  } else if (mainOrder.length === 0) {
    list = <p className="text-muted-foreground px-2 py-3 text-xs">{t('shell.sidebar.empty')}</p>;
  } else if (groups !== null) {
    list = groups.map((group) => <GroupSection key={group.key} group={group} context={context} />);
  } else {
    list = <Rows items={flat} context={context} />;
  }

  return (
    // w-72: the two-line entries (path, branch, model, context) need the room (Plan "Sidebar").
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-72 shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
        <LayersIcon aria-hidden className="text-brand size-4" />
        <span className="font-semibold tracking-tight">{PRODUCT_NAME}</span>
        {hostState?.backend === 'fake' ? (
          // R3-02: never mistake the FakeBackend for the real claude (e.g. a forgotten fake server).
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="warning" data-slot="backend-fake">
                {t('shell.sidebar.fakeBadge')}
                <span className="sr-only">{t('shell.sidebar.fakeHint')}</span>
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{t('shell.sidebar.fakeHint')}</TooltipContent>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Toggle
              size="sm"
              data-slot="sidebar-mode"
              aria-label={t('navigation.sidebar.grouped')}
              pressed={mode === 'grouped'}
              onPressedChange={(pressed) => {
                setSidebarMode(pressed ? 'grouped' : 'flat');
              }}
            >
              <FolderTreeIcon aria-hidden />
            </Toggle>
          </TooltipTrigger>
          <TooltipContent>
            {t(mode === 'grouped' ? 'navigation.sidebar.flat' : 'navigation.sidebar.grouped')}
          </TooltipContent>
        </Tooltip>
        <IconButton label={t('shell.sidebar.newSession')} data-action="new-session" onClick={openNewSession}>
          <SquarePenIcon aria-hidden />
        </IconButton>
        <SettingsMenu />
      </div>
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
      <nav
        aria-label={t('shell.sidebar.label')}
        data-view={archive ? 'archive' : mode}
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
