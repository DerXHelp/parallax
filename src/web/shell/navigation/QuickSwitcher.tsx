import { GitBranchIcon, SearchIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import type { ProfileSummary } from '@shared/model';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { fuzzyFilter } from '@web/lib/fuzzy';
import { pathTail } from '@web/lib/path-display';
import { flatSidebarOrder, waitingFirst, type OrderedSession } from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';
import { openSessionWindow } from '@web/lib/windows';
import { useNow } from '@web/state/clock';
import { useHostStates, useSelectedSession, useSummaries, type SummaryEntry } from '@web/state/hooks';
import { CommandInput, CommandList, handleCommandKey, type CommandModifiers } from '@web/ui/command-list';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/ui/dialog';
import { StatusIcon } from '@web/ui/status-icon';
import { PROFILE_BG } from './profile-colors';
import { setArchiveView } from './sidebar-view';

type Item = OrderedSession<SummaryEntry>;

function SwitcherItem({
  item,
  profile,
  showProfile,
  now,
}: {
  item: Item;
  profile: ProfileSummary | undefined;
  showProfile: boolean;
  now: number;
}) {
  const t = useT();
  const format = useFormat();
  const { summary } = item.entry;
  return (
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <StatusIcon kind={item.status.kind} className="shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate', item.status.unread && 'font-semibold')}>
          {sessionTitle(summary)}
        </span>
        {item.status.needsAttention ? (
          <span className="text-status-waiting shrink-0 text-2xs">{t('navigation.switcher.waiting')}</span>
        ) : null}
        <span className="text-muted-foreground shrink-0 text-2xs tabular-nums">
          {format.relative(summary.lastActivityAt, now, 'narrow')}
        </span>
      </span>
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 pl-5.5 text-2xs">
        <span className="min-w-0 truncate">{pathTail(summary.cwd)}</span>
        {summary.gitBranch === null ? null : (
          <span className="flex min-w-0 items-center gap-0.5">
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="sr-only">{t('navigation.row.branch')}</span>
            <span className="truncate">{summary.gitBranch}</span>
          </span>
        )}
        {showProfile && profile !== undefined ? (
          <span className="flex shrink-0 items-center gap-1">
            <span aria-hidden className={cn('size-1.5 rounded-full', PROFILE_BG[profile.color])} />
            {profile.name}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function QuickSwitcherContent({ onClose }: { onClose: () => void }) {
  const t = useT();
  const entries = useSummaries();
  const hostStates = useHostStates();
  const now = useNow(30_000);
  const [, select] = useSelectedSession();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const profiles = useMemo(() => {
    const map = new Map<string, ProfileSummary>();
    for (const [hostId, state] of Object.entries(hostStates)) {
      for (const profile of state.profiles) map.set(`${hostId}|${profile.id}`, profile);
    }
    return map;
  }, [hostStates]);
  const profileOf = (entry: SummaryEntry) => profiles.get(`${entry.hostId}|${entry.summary.profileId}`);
  const showProfile = profiles.size > 1;

  const base = useMemo(() => waitingFirst(flatSidebarOrder(entries, new Date(now))), [entries, now]);
  const items = useMemo(
    () =>
      waitingFirst(
        fuzzyFilter(base, query, ({ entry }) => [
          sessionTitle(entry.summary),
          pathTail(entry.summary.cwd),
          entry.summary.gitBranch ?? '',
          profiles.get(`${entry.hostId}|${entry.summary.profileId}`)?.name ?? '',
        ]),
      ),
    [base, query, profiles],
  );
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1);

  const choose = (item: Item, modifiers: CommandModifiers) => {
    if (modifiers.shiftKey && item.entry.hostId === LOCAL_HOST_ID) {
      openSessionWindow(item.entry.summary.entryId);
    } else {
      setArchiveView(false);
      select(item.entry.sessionKey);
    }
    onClose();
  };

  return (
    <DialogContent
      data-slot="quick-switcher"
      showCloseButton={false}
      className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
    >
      <DialogTitle className="sr-only">{t('navigation.switcher.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('navigation.switcher.description')}</DialogDescription>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <SearchIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <CommandInput
          listId={listId}
          activeIndex={activeIndex}
          count={items.length}
          value={query}
          aria-label={t('navigation.switcher.title')}
          placeholder={t('navigation.switcher.placeholder')}
          className="border-0 px-0 shadow-none focus-visible:ring-0"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            handleCommandKey(event, {
              count: items.length,
              activeIndex,
              onActiveIndexChange: setActive,
              onSelectActive: (modifiers) => {
                const item = items[activeIndex];
                if (item !== undefined) choose(item, modifiers);
              },
            });
          }}
        />
      </div>
      <CommandList
        id={listId}
        label={t('navigation.switcher.list')}
        items={items}
        getKey={(item) => item.entry.sessionKey}
        activeIndex={activeIndex}
        onActiveIndexChange={setActive}
        onSelect={choose}
        empty={t('navigation.switcher.empty')}
        className="max-h-[min(22rem,55vh)] p-1"
        renderItem={(item) => (
          <SwitcherItem item={item} profile={profileOf(item.entry)} showProfile={showProfile} now={now} />
        )}
      />
      <p className="text-muted-foreground border-t px-3 py-1.5 text-2xs">{t('navigation.switcher.hint')}</p>
    </DialogContent>
  );
}

/**
 * Quick switcher (Plan "Kontextwechsel", ADR-118: Ctrl+K or the request `quickSwitcher`): fuzzy
 * search over title, folder, branch and profile; waiting sessions first; Enter opens, Shift+Enter
 * opens in a new window, arrows move, Esc closes. Archived sessions are not listed.
 */
export function QuickSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <QuickSwitcherContent
          onClose={() => {
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}
