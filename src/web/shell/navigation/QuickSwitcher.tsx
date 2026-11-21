import { GitBranchIcon, SearchIcon, TextSearchIcon } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { LIMITS, LOCAL_HOST_ID } from '@shared/common';
import type { ProfileSummary } from '@shared/model';
import { useFormat, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { fuzzyFilter, type FuzzyFilterOptions } from '@web/lib/fuzzy';
import { pathTail } from '@web/lib/path-display';
import { useReturnFocus } from '@web/lib/return-focus';
import {
  flatSidebarOrder,
  sessionProjectPath,
  waitingFirst,
  type OrderedSession,
} from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';
import { openSessionWindow } from '@web/lib/windows';
import { useNow } from '@web/state/clock';
import { useProfilesByHost, useSelectedSession, useSummaries, type SummaryEntry } from '@web/state/hooks';
import { selectHostFeature } from '@web/state/hosts';
import { clientStore, type ClientState } from '@web/state/store';
import { CommandInput, CommandList, handleCommandKey, type CommandModifiers } from '@web/ui/command-list';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/ui/dialog';
import { Kbd } from '@web/ui/kbd';
import { StatusIcon } from '@web/ui/status-icon';
import { focusSessionInput } from '../NewSessionForm';
import { requestShell } from '../requests';
import { shortcutKeyLabels } from '../shortcuts';
import { PathTail } from './PathTail';
import { PROFILE_BG } from './profile-colors';
import { setArchiveView } from './sidebar-view';

type Item = OrderedSession<SummaryEntry>;

/** WP-115: the last option "Search in contents: …" (request `search.open`, WP-110 §3.6). */
interface SearchContents {
  search: string;
}

type SwitcherOption = Item | SearchContents;

function isSearchOption(option: SwitcherOption): option is SearchContents {
  return 'search' in option;
}

/** Shortcut of the full-text search (features/search registers it; shown in the option). */
const SEARCH_KEYS = 'Mod+Shift+F';

/** Some connected computer searches contents (`HostState.features.search`). */
function selectAnySearch(state: ClientState): boolean {
  return Object.keys(state.hosts).some((hostId) => selectHostFeature(state, hostId, 'search'));
}

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
        {/* WP41-02: the project folder stays whole, the folder before it shrinks (WP-115: the
            main repository of a worktree session). */}
        <PathTail path={sessionProjectPath(summary)} data-slot="switcher-path" />
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

/** WP-115: the option "Search in contents: “…”" with the shortcut of the search. */
function SearchContentsItem({ text }: { text: string }) {
  const t = useT();
  return (
    <span data-slot="switcher-search" className="flex min-w-0 flex-1 items-center gap-2">
      <TextSearchIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t('navigation.switcher.searchContents', { text })}</span>
      <Kbd className="shrink-0">{shortcutKeyLabels(SEARCH_KEYS, t).join('+')}</Kbd>
    </span>
  );
}

/**
 * Ranking with a query (V3-03): match quality first – scattered hits are dropped, the title wins
 * near ties over folder, branch and profile –, waiting sessions only on equal scores (the base
 * order). Without a query: waiting first, then the sidebar order.
 */
const SEARCH: FuzzyFilterOptions = { strict: true, keyPenalty: 1 };

function QuickSwitcherContent({
  onClose,
  onSearch,
  onCloseAutoFocus,
}: {
  /** `sessionKey`: the session chosen for this window (its message field gets the focus). */
  onClose: (sessionKey?: string) => void;
  /** WP-115: "Search in contents" was chosen – closes the switcher, then opens the search. */
  onSearch: (text: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useT();
  const entries = useSummaries();
  const profiles = useProfilesByHost();
  const now = useNow(30_000);
  const [, select] = useSelectedSession();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const canSearch = useStore(clientStore, selectAnySearch);

  const profileOf = (entry: SummaryEntry) => profiles.get(entry.hostId, entry.summary.profileId);
  const showProfile = profiles.size > 1;

  const base = useMemo(() => waitingFirst(flatSidebarOrder(entries, new Date(now))), [entries, now]);
  const items = useMemo(
    () =>
      fuzzyFilter(
        base,
        query,
        ({ entry }) => [
          sessionTitle(entry.summary),
          pathTail(sessionProjectPath(entry.summary)),
          entry.summary.gitBranch ?? entry.summary.worktree?.branch ?? '',
          profiles.get(entry.hostId, entry.summary.profileId)?.name ?? '',
        ],
        SEARCH,
      ),
    [base, query, profiles],
  );
  // WP-115: last option "Search in contents: …" once the text is long enough for `search.query`.
  const searchText = query.trim();
  const options = useMemo<SwitcherOption[]>(
    () =>
      canSearch && searchText.length >= LIMITS.searchTextMin
        ? [...items, { search: searchText.slice(0, LIMITS.searchTextMax) }]
        : items,
    [canSearch, items, searchText],
  );
  const activeIndex = options.length === 0 ? -1 : Math.min(active, options.length - 1);

  const choose = (option: SwitcherOption, modifiers: CommandModifiers) => {
    if (isSearchOption(option)) {
      onSearch(option.search);
      return;
    }
    const item = option;
    if (modifiers.shiftKey && item.entry.hostId === LOCAL_HOST_ID) {
      openSessionWindow(item.entry.summary.entryId);
      onClose();
      return;
    }
    setArchiveView(false);
    select(item.entry.sessionKey);
    onClose(item.entry.sessionKey);
  };

  return (
    <DialogContent
      data-slot="quick-switcher"
      showCloseButton={false}
      onCloseAutoFocus={onCloseAutoFocus}
      className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
    >
      <DialogTitle className="sr-only">{t('navigation.switcher.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('navigation.switcher.description')}</DialogDescription>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <SearchIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <CommandInput
          listId={listId}
          activeIndex={activeIndex}
          count={options.length}
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
              count: options.length,
              activeIndex,
              onActiveIndexChange: setActive,
              onSelectActive: (modifiers) => {
                const option = options[activeIndex];
                if (option !== undefined) choose(option, modifiers);
              },
            });
          }}
        />
      </div>
      <CommandList
        id={listId}
        label={t('navigation.switcher.list')}
        items={options}
        getKey={(option) => (isSearchOption(option) ? 'search-contents' : option.entry.sessionKey)}
        activeIndex={activeIndex}
        onActiveIndexChange={setActive}
        onSelect={choose}
        empty={t('navigation.switcher.empty')}
        className="max-h-[min(22rem,55vh)] p-1"
        renderItem={(option) =>
          isSearchOption(option) ? (
            <SearchContentsItem text={option.search} />
          ) : (
            <SwitcherItem
              item={option}
              profile={profileOf(option.entry)}
              showProfile={showProfile}
              now={now}
            />
          )
        }
      />
      <p className="text-muted-foreground border-t px-3 py-1.5 text-2xs">{t('navigation.switcher.hint')}</p>
    </DialogContent>
  );
}

/**
 * Quick switcher (Plan "Kontextwechsel", ADR-118: Ctrl+K or the request `quickSwitcher`): fuzzy
 * search over title, folder, branch and profile; waiting sessions first; Enter opens, Shift+Enter
 * opens in a new window, arrows move, Esc closes. Archived sessions are not listed. Focus (R4W-04,
 * V3-04): Enter puts it into the message field of the chosen session, Esc and Shift+Enter give it
 * back to where it was before Ctrl+K. WP-115: with at least two characters and a computer that
 * searches contents, the last option "Search in contents: …" closes the switcher and opens the
 * full-text search with the text (request `search.open`; nobody takes it → the focus goes back).
 */
export function QuickSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const chosen = useRef<string | null>(null);
  const searchText = useRef<string | null>(null);
  const returnFocus = useReturnFocus(open);
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      const sessionKey = chosen.current;
      const search = searchText.current;
      chosen.current = null;
      searchText.current = null;
      if (search !== null && requestShell({ kind: 'search.open', text: search })) {
        // The search dialog opens now and takes the focus (its own focus return on close).
        event.preventDefault();
        return;
      }
      if (sessionKey === null) {
        returnFocus(event);
        return;
      }
      event.preventDefault();
      focusSessionInput(sessionKey);
    },
    [returnFocus],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <QuickSwitcherContent
          onCloseAutoFocus={onCloseAutoFocus}
          onClose={(sessionKey) => {
            chosen.current = sessionKey ?? null;
            onOpenChange(false);
          }}
          onSearch={(text) => {
            searchText.current = text;
            onOpenChange(false);
          }}
        />
      ) : null}
    </Dialog>
  );
}
