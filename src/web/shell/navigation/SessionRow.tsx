import { ArchiveRestoreIcon, EllipsisIcon, GitBranchIcon, PinIcon } from 'lucide-react';
import { memo, useMemo, useState, type FocusEvent } from 'react';
import type { EffortLevel } from '@shared/common';
import type { ContextGauge, ProfileColor, RunningTasks, SessionSummary, TaskKind } from '@shared/model';
import type { DisplayStatusKind } from '@shared/status';
import { runningTaskTotal } from '@shared/tasks';
import { useFormat, useT } from '@web/i18n';
import { sessionLine } from '@web/lib/activity';
import { cn } from '@web/lib/cn';
import type { ContextLevel } from '@web/lib/context-display';
import { effectiveEffort } from '@web/lib/effort';
import { shortModelName } from '@web/lib/model-name';
import { sessionTitle } from '@web/lib/session-title';
import { cliVersionStatus, knownVersion } from '@web/lib/version';
import type { SummaryEntry } from '@web/state/hooks';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@web/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ContextCompactIcon, useContextTexts } from '../context-display';
import { RunningCounts, TASK_KIND_ICON, useRunningWords } from '../running-tasks';
import { PathTail } from './PathTail';
import { PROFILE_BG } from './profile-colors';
import { RemoteControlIcon, showsRemoteInRow, useRemoteControlTexts } from './remote-control';
import { startRename, useRenaming } from './rename';
import { RenameField } from './RenameField';
import { SessionLineText, useSessionLineText } from './session-line';
import {
  SIDEBAR_ACTIONS,
  SessionActionItems,
  runSessionCommand,
  sessionActions,
  sessionMenuCloseAutoFocus,
} from './session-actions';

const BAR_FILL: Readonly<Record<ContextLevel, string>> = {
  normal: 'bg-foreground/45',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

const BAR_TEXT: Readonly<Record<ContextLevel, string>> = {
  normal: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

/**
 * Context fill of a row (WP-63 §1.4, `@web/lib/context-display`): the bar runs up to the
 * autocompact, the color says "really full" (share of the model window: from 50 % yellow, from
 * 80 % red), a symbol says "autocompact soon"; the visible value is the used tokens ("260K").
 * Inside the row button a `role="meter"` would be flattened into the button name – so a hidden bar
 * plus the visible value, labelled "Context" for screen readers; the details are in the row's
 * tooltip.
 */
function RowContext({ context }: { context: ContextGauge }) {
  const t = useT();
  const texts = useContextTexts(context);
  const { level, fill } = texts.display;
  return (
    <span
      data-slot="row-context"
      data-level={level}
      data-compact-soon={texts.compactSoon === null ? undefined : 'true'}
      className="flex shrink-0 items-center gap-1"
    >
      <span className="sr-only">{t('navigation.row.context')}</span>
      <span aria-hidden className="bg-muted relative h-1 w-6 overflow-hidden rounded-full">
        <span
          className={cn('absolute inset-y-0 left-0 rounded-full', BAR_FILL[level])}
          style={{ width: `${String(fill)}%` }}
        />
      </span>
      <span className={cn('tabular-nums', BAR_TEXT[level])}>{texts.short}</span>
      {texts.compactSoon === null ? null : (
        <>
          <ContextCompactIcon />
          <span className="sr-only">{t('navigation.row.compactSoon')}</span>
        </>
      )}
    </span>
  );
}

/** Context line of the row's tooltip (WP-63 §1.4). */
function RowContextDetail({ context }: { context: ContextGauge }) {
  const t = useT();
  const texts = useContextTexts(context);
  return (
    <span data-slot="row-context-detail" className="text-muted-foreground tabular-nums">
      {t('navigation.row.context')}: {texts.detail}
      {texts.compactSoon === null ? null : <span className="block">{texts.compactSoon}</span>}
    </span>
  );
}

/** WP-64: Remote Control in line 1 (quiet when connected, muted while connecting, warning on failure). */
function RowRemote({ remote }: { remote: SessionSummary['remoteControl'] }) {
  const { status } = useRemoteControlTexts(remote);
  return (
    <span data-slot="row-remote" data-remote-state={remote.state} className="flex shrink-0 items-center">
      <RemoteControlIcon remote={remote} />
      <span className="sr-only">{status}</span>
    </span>
  );
}

/** WP-64: Remote Control line of the row's tooltip (status and the readable error). */
function RowRemoteDetail({ remote }: { remote: SessionSummary['remoteControl'] }) {
  const { status, error } = useRemoteControlTexts(remote);
  return (
    <span data-slot="row-remote-detail" className="text-muted-foreground">
      {status}
      {error === null ? null : <span className="text-warning block">{error}</span>}
    </span>
  );
}

/** Counters above this show as "9+" – the row stays narrow. */
const ROW_COUNTER_MAX = 9;

/**
 * WP-71: what runs, next to the title – agent symbol + number, terminal symbol + number, the rest;
 * not clickable (the row is the button), named in words for screen readers.
 */
function RowTasks({ tasks }: { tasks: RunningTasks }) {
  const t = useT();
  const words = useRunningWords(tasks);
  return (
    <span data-slot="row-tasks" className="text-status-working flex shrink-0 items-center text-2xs">
      <RunningCounts counts={tasks} max={ROW_COUNTER_MAX} />
      <span className="sr-only">{t('navigation.running.label', { list: words })}</span>
    </span>
  );
}

const KIND_KEY: Readonly<Record<TaskKind, 'agent' | 'bash' | 'workflow' | 'task'>> = {
  agent: 'agent',
  bash: 'bash',
  workflow: 'workflow',
  other: 'task',
};

/** WP-71: "Running now" in the row's tooltip – up to five tasks (kind, type, label), then "and n more". */
function RowTasksDetail({ tasks }: { tasks: RunningTasks }) {
  const t = useT();
  const more = runningTaskTotal(tasks) - tasks.items.length;
  return (
    <span data-slot="row-tasks-detail" className="mt-0.5 grid gap-0.5">
      <span className="font-medium">{t('navigation.running.title')}</span>
      {tasks.items.map((item, index) => {
        const Icon = TASK_KIND_ICON[item.kind];
        return (
          <span
            key={`${item.kind}:${String(index)}`}
            data-slot="row-task"
            data-kind={item.kind}
            className="flex min-w-0 items-start gap-1.5"
          >
            <Icon aria-hidden className="text-status-working mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="text-muted-foreground">
                {t(`navigation.running.kind.${KIND_KEY[item.kind]}`)}
                {item.subagentType === null ? null : (
                  <>
                    <span aria-hidden className="mx-1">
                      ·
                    </span>
                    {item.subagentType}
                  </>
                )}
                {item.label === '' ? null : ':'}
              </span>
              {item.label === '' ? null : <span className="ml-1">{item.label}</span>}
            </span>
          </span>
        );
      })}
      {more > 0 ? (
        <span className="text-muted-foreground">{t('navigation.running.more', { count: more })}</span>
      ) : null}
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
  /** WP-63 §1.1: effort default of the profile (shown when the session has no own value). */
  profileEffort?: EffortLevel | null;
  /** Minimum CLI of the SDK (`host.state.sdkClaudeCodeVersion`) for the version rule C.7. */
  requiredCli: string | null;
  /** Line 2 starts with the path (false in the grouped view: the group header names the folder). */
  showPath: boolean;
  onSelect: (sessionKey: string) => void;
}

/**
 * Sidebar entry (Plan "Sidebar"): line 1 status icon (+ text for screen readers), title,
 * pin, relative time, unread dot; WP-65: then the quiet session line (live sentence / turn summary,
 * `@web/lib/activity`) when there is one; last line: the last two path segments (the last one never cut first,
 * WP41-02), ⎇ branch, short model name,
 * context fill. Profile color stripe on the left, details in the tooltip. WP-71: a working,
 * starting or background session pulses (status icon, `status-working`; one CSS animation per row,
 * motion-safe) and shows what runs (agents, shells, the rest) next to the title and in the
 * tooltip – from `summary.runningTasks`, so a text delta never re-renders a row. Right click (or
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
  profileEffort = null,
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
  const effort = effectiveEffort({ effort: summary.effort, profileEffort });
  const showActions = !editing && (hovered || focusWithin || menuOpen || contextOpen);
  // WP-65 §1.1: live sentence while working, turn summary afterwards (null = nothing to say).
  const line = useMemo(() => sessionLine(summary, statusKind), [summary, statusKind]);
  const lineText = useSessionLineText(line);
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
                  <StatusIcon kind={statusKind} pulse className="shrink-0" />
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
                  {summary.runningTasks === null ? null : <RowTasks tasks={summary.runningTasks} />}
                  {showsRemoteInRow(summary.remoteControl) ? <RowRemote remote={summary.remoteControl} /> : null}
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
                {line === null ? null : (
                  <span className="flex h-4 min-w-0 items-center pl-5.5 text-2xs">
                    <SessionLineText line={line} />
                  </span>
                )}
                <span
                  data-slot="row-details"
                  className="text-muted-foreground flex h-4 min-w-0 items-center gap-1.5 pl-5.5 text-2xs"
                >
                  {/* Grouped: the group header names the folder. Path and branch shrink, the model stays;
                      in the path the folder before the project folder gives way first (WP41-02). */}
                  {showPath ? (
                    <PathTail path={summary.cwd} data-slot="row-path" className="min-w-10 shrink" />
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
                  {/* WP-63 §1.1: quiet short form, never more prominent than the model. */}
                  {effort === null ? null : (
                    <span data-slot="row-effort" data-effort={effort} className="shrink-0 opacity-80">
                      <span className="sr-only">{t('navigation.row.effort')}</span>
                      {t(`shell.effortShort.${effort}`)}
                    </span>
                  )}
                  {summary.context === null || summary.archived ? null : (
                    <RowContext context={summary.context} />
                  )}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" align="start" className="max-w-96">
              <div className="grid gap-0.5">
                <span className="font-medium">{title}</span>
                <span>{t(`status.${statusKind}`)}</span>
                {lineText === null ? null : <span className="break-words">{lineText}</span>}
                {summary.runningTasks === null ? null : <RowTasksDetail tasks={summary.runningTasks} />}
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
                {model === null ? null : (
                  <span className="text-muted-foreground">
                    {t('navigation.row.model')}: {model}
                    {effort === null ? null : (
                      <>
                        <span aria-hidden className="mx-1">
                          ·
                        </span>
                        {t(`shell.effortLevels.${effort}`)}
                      </>
                    )}
                  </span>
                )}
                {summary.context === null || summary.archived ? null : (
                  <RowContextDetail context={summary.context} />
                )}
                {showsRemoteInRow(summary.remoteControl) ? (
                  <RowRemoteDetail remote={summary.remoteControl} />
                ) : null}
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
