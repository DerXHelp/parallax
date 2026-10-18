import { ArchiveRestoreIcon, EllipsisIcon, GitBranchIcon, PinIcon } from 'lucide-react';
import { memo, useMemo, useState, type FocusEvent } from 'react';
import type { ProfileColor } from '@shared/model';
import type { DisplayStatusKind } from '@shared/status';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { shortModelName } from '@web/lib/model-name';
import { pathTail } from '@web/lib/path-display';
import { sessionTitle } from '@web/lib/session-title';
import { cliVersionStatus, knownVersion } from '@web/lib/version';
import type { SummaryEntry } from '@web/state/hooks';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@web/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@web/ui/dropdown-menu';
import { gaugeLevel, type GaugeLevel } from '@web/ui/gauge';
import { IconButton } from '@web/ui/icon-button';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { PROFILE_BG } from './profile-colors';
import { startRename, useRenaming } from './rename';
import { RenameField } from './RenameField';
import {
  SIDEBAR_ACTIONS,
  SessionActionItems,
  runSessionCommand,
  sessionActions,
  sessionMenuCloseAutoFocus,
} from './session-actions';

const BAR_FILL: Readonly<Record<GaugeLevel, string>> = {
  normal: 'bg-foreground/45',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

const BAR_TEXT: Readonly<Record<GaugeLevel, string>> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/**
 * Context fill of a row (Plan "Sidebar": from 70 % yellow, from 85 % red, `gaugeLevel`). Inside the
 * row button a `role="meter"` would be flattened into the button name – so a hidden bar plus the
 * visible percentage, labelled "Context" for screen readers.
 */
function RowContext({ percent }: { percent: number }) {
  const t = useT();
  const format = useFormat();
  const level = gaugeLevel(percent);
  const width = Math.min(100, Math.max(0, percent));
  return (
    <span data-slot="row-context" data-level={level} className="flex shrink-0 items-center gap-1">
      <span className="sr-only">{t('navigation.row.context')}</span>
      <span aria-hidden className="bg-muted relative h-1 w-6 overflow-hidden rounded-full">
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', BAR_FILL[level])}
          style={{ width: `${String(width)}%` }}
        />
      </span>
      <span className={cn('tabular-nums', BAR_TEXT[level])}>{format.percent(percent)}</span>
    </span>
  );
}

/**
 * Only primitives and stable references (R1W-05): `entry` keeps its identity while its summary is
 * unchanged (hooks.ts), so a `summary.upsert` re-renders just that row.
 */
export interface SessionRowProps {
  entry: SummaryEntry;
  statusKind: DisplayStatusKind;
  unread: boolean;
  now: number;
  selected: boolean;
  /** Roving tabindex (V1-11): exactly one row of the list is a tab stop. */
  tabStop: boolean;
  profileColor: ProfileColor | null;
  profileName: string | null;
  /** Minimum CLI of the SDK (`host.state.sdkClaudeCodeVersion`) for the version rule C.7. */
  requiredCli: string | null;
  /** Line 2 starts with the path (false in the grouped view: the group header names the folder). */
  showPath: boolean;
  onSelect: (sessionKey: string) => void;
}

/**
 * Two-line sidebar entry (Plan "Sidebar"): line 1 status icon (+ text for screen readers), title,
 * pin, relative time, unread dot; line 2 last two path segments, ⎇ branch, short model name,
 * context fill. Profile color stripe on the left, details in the tooltip. Right click (or
 * Shift+F10) opens the context menu; the "…" button (on hover/focus) the same actions. Double
 * click on the title or F2 edits it inline.
 */
export const SessionRow = memo(function SessionRow({
  entry,
  statusKind,
  unread,
  now,
  selected,
  tabStop,
  profileColor,
  profileName,
  requiredCli,
  showPath,
  onSelect,
}: SessionRowProps) {
  const t = useT();
  const format = useFormat();
  const { summary, sessionKey } = entry;
  const editing = useRenaming(sessionKey, 'sidebar');
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tooltip, setTooltip] = useState(false);
  const onMenuCloseAutoFocus = useMemo(() => sessionMenuCloseAutoFocus(sessionKey, 'sidebar'), [sessionKey]);

  const relative = format.relative(summary.lastActivityAt, now, 'narrow');
  const title = sessionTitle(summary);
  const cliVersion = knownVersion(summary.cliVersion);
  const model = shortModelName(summary.model ?? summary.modelSetting);
  const showActions = !editing && (hovered || focusWithin || menuOpen || contextOpen);
  const actions =
    contextOpen || menuOpen ? sessionActions(SIDEBAR_ACTIONS, sessionKey, summary, 'sidebar') : [];

  const onBlur = (event: FocusEvent<HTMLLIElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocusWithin(false);
  };

  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger asChild disabled={editing}>
        <li
          className="relative min-w-0"
          data-row={sessionKey}
          onPointerEnter={() => {
            setHovered(true);
          }}
          onPointerLeave={() => {
            setHovered(false);
          }}
          onFocus={() => {
            setFocusWithin(true);
          }}
          onBlur={onBlur}
        >
          {editing ? (
            <div className="py-1 pr-2 pl-1.5">
              <RenameField sessionKey={sessionKey} summary={summary} />
            </div>
          ) : null}
          {/* Closed while a menu of the row is open (the menus cover the same spot). */}
          <Tooltip
            open={tooltip && !menuOpen && !contextOpen}
            onOpenChange={setTooltip}
            disableHoverableContent
          >
            <TooltipTrigger asChild>
              <button
                type="button"
                hidden={editing}
                data-session-row={sessionKey}
                aria-current={selected ? 'true' : undefined}
                tabIndex={tabStop ? 0 : -1}
                onClick={() => {
                  onSelect(sessionKey);
                }}
                className={cn(
                  'hover:bg-sidebar-accent/70 focus-visible:ring-ring relative grid w-full gap-0.5 rounded-sm py-1 pr-2 pl-2.5 text-left outline-none focus-visible:ring-2',
                  selected && 'bg-sidebar-accent text-sidebar-accent-foreground',
                )}
              >
                {profileColor === null ? null : (
                  <span
                    aria-hidden
                    className={cn('absolute inset-y-1 left-0.5 w-0.5 rounded-full', PROFILE_BG[profileColor])}
                  />
                )}
                <span className="flex h-5 min-w-0 items-center gap-2">
                  <StatusIcon kind={statusKind} className="shrink-0" />
                  <span
                    data-slot="row-title"
                    className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold')}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      startRename(sessionKey, 'sidebar');
                    }}
                  >
                    {title}
                  </span>
                  {summary.pinned ? (
                    <span data-slot="row-pinned" className="text-muted-foreground shrink-0">
                      <PinIcon aria-hidden className="size-3" />
                      <span className="sr-only">{t('shell.sidebar.pinned')}</span>
                    </span>
                  ) : null}
                  {/* While the "…" button shows, it covers time and unread dot (opacity keeps them
                      in the accessible name of the row). */}
                  <span
                    className={cn(
                      'text-muted-foreground shrink-0 text-2xs tabular-nums',
                      showActions && 'opacity-0',
                    )}
                  >
                    {relative}
                  </span>
                  {unread ? (
                    <span
                      className={cn('bg-brand size-1.5 shrink-0 rounded-full', showActions && 'opacity-0')}
                    >
                      <span className="sr-only">{t('shell.sidebar.unread')}</span>
                    </span>
                  ) : null}
                </span>
                <span
                  data-slot="row-details"
                  className="text-muted-foreground flex h-4 min-w-0 items-center gap-1.5 pl-5.5 text-2xs"
                >
                  {/* Grouped: the group header names the folder. Path and branch shrink, the model stays. */}
                  {showPath ? (
                    <span data-slot="row-path" className="min-w-10 shrink truncate">
                      {pathTail(summary.cwd, 2)}
                    </span>
                  ) : null}
                  {summary.gitBranch === null ? null : (
                    <span data-slot="row-branch" className="flex min-w-10 shrink-[2] items-center gap-0.5">
                      <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                      <span className="sr-only">{t('navigation.row.branch')}</span>
                      <span className="truncate">{summary.gitBranch}</span>
                    </span>
                  )}
                  {model === null ? null : (
                    <span data-slot="row-model" className="max-w-20 shrink-0 truncate">
                      <span className="sr-only">{t('navigation.row.model')}</span>
                      {model}
                    </span>
                  )}
                  {summary.context === null || summary.archived ? null : (
                    <RowContext percent={summary.context.percentage} />
                  )}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" align="start" className="max-w-96">
              <div className="grid gap-0.5">
                <span className="font-medium">{title}</span>
                <span>{t(`status.${statusKind}`)}</span>
                <span className="text-muted-foreground font-mono break-all">{summary.cwd}</span>
                {summary.gitBranch === null ? null : (
                  <span className="text-muted-foreground">
                    {t('navigation.row.branch')}: {summary.gitBranch}
                  </span>
                )}
                {profileName === null ? null : (
                  <span className="text-muted-foreground">
                    {t('shell.session.profile')}: {profileName}
                  </span>
                )}
                {cliVersion === null ? null : (
                  <span data-slot="row-cli-version" className="text-muted-foreground">
                    {t('shell.session.cliVersion', { version: cliVersion })}
                    {cliVersionStatus(cliVersion, requiredCli) === 'too_old' && requiredCli !== null ? (
                      <span className="text-destructive block">
                        {t('shell.session.cliTooOld', { required: requiredCli })}
                      </span>
                    ) : null}
                  </span>
                )}
                {summary.sessionId === null ? null : (
                  <span className="text-muted-foreground font-mono">
                    {t('shell.session.sessionId')}: {summary.sessionId}
                  </span>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
          {summary.archived && !editing ? (
            // No tab stop (R4W-13: the list stays one tab stop); the keyboard restores through the
            // row's "…" menu or context menu.
            <IconButton
              label={t('navigation.actions.restore')}
              size="icon-xs"
              tabIndex={-1}
              data-action="restore"
              className="bg-sidebar-accent absolute right-1 bottom-1"
              onClick={() => {
                runSessionCommand(sessionKey, {
                  name: 'session.setArchived',
                  entryId: summary.entryId,
                  archived: false,
                });
              }}
            >
              <ArchiveRestoreIcon aria-hidden />
            </IconButton>
          ) : null}
          {showActions ? (
            <DropdownMenu onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <IconButton
                  label={t('navigation.row.actions', { title })}
                  size="icon-xs"
                  showTooltip={false}
                  data-slot="row-actions"
                  className="bg-sidebar-accent absolute top-1 right-1"
                >
                  <EllipsisIcon aria-hidden />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right" onCloseAutoFocus={onMenuCloseAutoFocus}>
                <SessionActionItems actions={actions} kind="dropdown" />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={t('navigation.row.actions', { title })}
        onCloseAutoFocus={onMenuCloseAutoFocus}
        data-session-menu={sessionKey}
      >
        <SessionActionItems actions={actions} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
});
