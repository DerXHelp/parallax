import { BellDotIcon, LayersIcon } from 'lucide-react';
import { memo, useMemo, type KeyboardEvent } from 'react';
import { PRODUCT_NAME } from '@shared/product';
import type { ProfileColor } from '@shared/model';
import type { DisplayStatus } from '@shared/status';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { orderSessions, type OrderedSession } from '@web/lib/session-order';
import { useNow } from '@web/state/clock';
import { useHostState, useSelectedSession, useSummaries, type SummaryEntry } from '@web/state/hooks';
import { StatusIcon } from '@web/ui/status-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { ConnectionIndicator } from './ConnectionIndicator';
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

interface RowProps {
  entry: SummaryEntry;
  status: DisplayStatus;
  now: number;
  selected: boolean;
  profileColor: ProfileColor | null;
  profileName: string | null;
  onSelect: (sessionKey: string) => void;
}

const SessionRow = memo(function SessionRow({
  entry,
  status,
  now,
  selected,
  profileColor,
  profileName,
  onSelect,
}: RowProps) {
  const t = useT();
  const format = useFormat();
  const { summary } = entry;
  const relative = format.relative(summary.lastActivityAt, now, 'narrow');
  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-session-row={entry.sessionKey}
            aria-current={selected ? 'true' : undefined}
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
            <StatusIcon kind={status.kind} />
            <span className={cn('min-w-0 flex-1 truncate', status.unread && 'font-semibold')}>
              {summary.title}
            </span>
            <span className="text-muted-foreground shrink-0 text-2xs tabular-nums">{relative}</span>
            {status.unread ? (
              <span className="bg-brand size-1.5 shrink-0 rounded-full">
                <span className="sr-only">{t('shell.sidebar.unread')}</span>
              </span>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" align="start" className="max-w-96">
          <div className="grid gap-0.5">
            <span className="font-medium">{summary.title}</span>
            <span>{t(`status.${status.kind}`)}</span>
            <span className="text-muted-foreground font-mono break-all">{summary.cwd}</span>
            {profileName === null ? null : (
              <span className="text-muted-foreground">
                {t('shell.session.profile')}: {profileName}
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

function focusRow(list: HTMLElement, delta: number): void {
  const rows = [...list.querySelectorAll<HTMLButtonElement>('[data-session-row]')];
  if (rows.length === 0) return;
  const current = rows.findIndex((row) => row === document.activeElement);
  const next = current < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, current + delta));
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
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusRow(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border flex w-64 shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <LayersIcon aria-hidden className="text-brand size-4" />
        <span className="font-semibold tracking-tight">{PRODUCT_NAME}</span>
        <span className="flex-1" />
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
      <nav aria-label={t('shell.sidebar.label')} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {ordered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">{t('shell.sidebar.empty')}</p>
        ) : (
          <ul role="list" className="grid gap-px" onKeyDown={onListKeyDown}>
            {ordered.map(({ entry, status }) => {
              const profile = profiles.get(entry.summary.profileId);
              return (
                <SessionRow
                  key={entry.sessionKey}
                  entry={entry}
                  status={status}
                  now={now}
                  selected={entry.sessionKey === selected}
                  profileColor={profile?.color ?? null}
                  profileName={profile?.name ?? null}
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
