import { BellDotIcon, LayersIcon, SquarePenIcon } from 'lucide-react';
import { memo, useMemo, type KeyboardEvent } from 'react';
import { PRODUCT_NAME } from '@shared/product';
import type { ProfileColor } from '@shared/model';
import type { DisplayStatusKind } from '@shared/status';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { orderSessions, type OrderedSession } from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';
import { cliVersionStatus, knownVersion } from '@web/lib/version';
import { useNow } from '@web/state/clock';
import { useHostState, useSelectedSession, useSummaries, type SummaryEntry } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { IconButton } from '@web/ui/icon-button';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ConnectionIndicator } from './ConnectionIndicator';
import { openNewSession } from './NewSessionDialog';
import { SettingsMenu } from './SettingsMenu';
import { useShortcut } from './shortcuts';

/** Static class names per profile color (Tailwind scans literal strings only). */
const PROFILE_STRIPE: Readonly<Record<ProfileColor, string>> = {
  slate: 'bg-profile-slate',
  blue: 'bg-profile-blue',
  green: 'bg-profile-green',
  amber: 'bg-profile-amber',
  red: 'bg-profile-red',
  violet: 'bg-profile-violet',
  pink: 'bg-profile-pink',
  teal: 'bg-profile-teal',
};

/**
 * Only primitives and stable references (R1W-05): `entry` keeps its identity while its summary is
 * unchanged (hooks.ts), so a `summary.upsert` re-renders just that row.
 */
interface RowProps {
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
  onSelect: (sessionKey: string) => void;
}

const SessionRow = memo(function SessionRow({
  entry,
  statusKind,
  unread,
  now,
  selected,
  tabStop,
  profileColor,
  profileName,
  requiredCli,
  onSelect,
}: RowProps) {
  const t = useT();
  const format = useFormat();
  const { summary } = entry;
  const relative = format.relative(summary.lastActivityAt, now, 'narrow');
  const title = sessionTitle(summary);
  const cliVersion = knownVersion(summary.cliVersion);
  return (
    <li className="min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-session-row={entry.sessionKey}
            aria-current={selected ? 'true' : undefined}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => {
              onSelect(entry.sessionKey);
            }}
            className={cn(
              'group/row hover:bg-sidebar-accent/70 focus-visible:ring-ring relative flex h-7 w-full items-center gap-2 rounded-sm pr-2 pl-2.5 text-left outline-none focus-visible:ring-2',
              selected && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )}
          >
            {profileColor === null ? null : (
              <span
                aria-hidden
                className={cn('absolute inset-y-1 left-0.5 w-0.5 rounded-full', PROFILE_STRIPE[profileColor])}
              />
            )}
            <StatusIcon kind={statusKind} className="shrink-0" />
            <span className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold')}>{title}</span>
            <span className="text-muted-foreground shrink-0 text-2xs tabular-nums">{relative}</span>
            {unread ? (
              <span className="bg-brand size-1.5 shrink-0 rounded-full">
                <span className="sr-only">{t('shell.sidebar.unread')}</span>
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="max-w-96">
          <div className="grid gap-0.5">
            <span className="font-medium">{title}</span>
            <span>{t(`status.${statusKind}`)}</span>
            <span className="text-muted-foreground font-mono break-all">{summary.cwd}</span>
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
    </li>
  );
});

/** Moves the focus within the list: `delta` rows, or to the first/last row (Home/End). */
function focusRow(list: HTMLElement, delta: number | 'first' | 'last'): void {
  const rows = [...list.querySelectorAll<HTMLButtonElement>('[data-session-row]')];
  if (rows.length === 0) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  let next: number;
  if (delta === 'first') next = 0;
  else if (delta === 'last') next = rows.length - 1;
  else next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
  rows[next]?.focus();
}

/**
 * Phase-1 sidebar: one line per session (status icon + text, title, activity, unread), sorted
 * waiting → activity; "Waiting for you (n)"; Alt+1…9 selects. The two-line entry with path, branch,
 * model and context bar follows in Phase 2 (Plan "Sidebar").
 */
export function Sidebar() {
  const t = useT();
  const entries = useSummaries();
  const now = useNow(30_000);
  const [selected, select] = useSelectedSession();
  const hostState = useHostState();
  const ordered: OrderedSession<SummaryEntry>[] = useMemo(
    () => orderSessions(entries, new Date(now)),
    [entries, now],
  );
  const waiting = ordered.filter((item) => item.status.needsAttention);
  const profiles = useMemo(
    () => new Map((hostState?.profiles ?? []).map((profile) => [profile.id, profile])),
    [hostState],
  );

  useShortcut({
    id: 'shell.selectSession',
    keys: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9'],
    displayKeys: 'Alt+1–9',
    description: 'shell.shortcuts.selectSession',
    allowInInputs: true,
    run: (_event, index) => {
      const target = ordered[index];
      if (target === undefined) return false;
      select(target.entry.sessionKey);
      return true;
    },
  });

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const moves: Readonly<Record<string, number | 'first' | 'last'>> = {
      ArrowDown: 1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    focusRow(event.currentTarget, move);
  };
  // The selected row is the tab stop; without a visible selection the first row.
  const tabStopKey = ordered.some((item) => item.entry.sessionKey === selected)
    ? selected
    : (ordered[0]?.entry.sessionKey ?? null);

  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-64 shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
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
        <IconButton label={t('shell.sidebar.newSession')} data-action="new-session" onClick={openNewSession}>
          <SquarePenIcon aria-hidden />
        </IconButton>
        <SettingsMenu />
      </div>
      {waiting.length > 0 ? (
        <button
          type="button"
          title={t('shell.sidebar.waitingAction')}
          onClick={() => {
            const first = waiting[0];
            if (first !== undefined) select(first.entry.sessionKey);
          }}
          className="text-status-waiting hover:bg-sidebar-accent/70 focus-visible:ring-ring mx-1.5 mb-1 flex h-7 items-center gap-2 rounded-sm px-2 text-xs font-medium outline-none focus-visible:ring-2"
        >
          <BellDotIcon aria-hidden className="size-3.5" />
          {t('shell.sidebar.waiting', { count: waiting.length })}
        </button>
      ) : null}
      <nav
        aria-label={t('shell.sidebar.label')}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2"
      >
        {ordered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">{t('shell.sidebar.empty')}</p>
        ) : (
          // One column that may shrink below the titles' width: long titles get an ellipsis,
          // time and unread dot stay visible, no horizontal scrollbar (V1-03).
          <ul role="list" className="grid grid-cols-[minmax(0,1fr)] gap-px" onKeyDown={onListKeyDown}>
            {ordered.map(({ entry, status }) => {
              const profile = profiles.get(entry.summary.profileId);
              return (
                <SessionRow
                  key={entry.sessionKey}
                  entry={entry}
                  statusKind={status.kind}
                  unread={status.unread}
                  now={now}
                  selected={entry.sessionKey === selected}
                  tabStop={entry.sessionKey === tabStopKey}
                  profileColor={profile?.color ?? null}
                  profileName={profile?.name ?? null}
                  requiredCli={knownVersion(hostState?.sdkClaudeCodeVersion ?? null)}
                  onSelect={select}
                />
              );
            })}
          </ul>
        )}
      </nav>
      <div className="border-sidebar-border flex h-7 shrink-0 items-center gap-2 border-t px-3 text-2xs">
        <ConnectionIndicator />
        <span className="flex-1" />
        <span className="text-muted-foreground tabular-nums">
          {t('shell.sidebar.count', { count: ordered.length })}
        </span>
      </div>
    </aside>
  );
}
