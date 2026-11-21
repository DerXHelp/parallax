import { TextSearchIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { LIMITS, type HostId } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { pathTail } from '@web/lib/path-display';
import { useReturnFocus } from '@web/lib/return-focus';
import { sessionProjectPath } from '@web/lib/session-order';
import { sessionTitle } from '@web/lib/session-title';
import { HostBadge } from '@web/shell/hosts/HostBadge';
import { setArchiveView } from '@web/shell/navigation/sidebar-view';
import { focusSessionInput } from '@web/shell/NewSessionForm';
import { useNow } from '@web/state/clock';
import { useSelectedSession, useSummaries } from '@web/state/hooks';
import { useHostLabels, type HostLabels } from '@web/state/hosts';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { CommandInput, commandOptionId, handleCommandKey } from '@web/ui/command-list';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@web/ui/dialog';
import { Label } from '@web/ui/label';
import { Spinner } from '@web/ui/spinner';
import { Switch } from '@web/ui/switch';
import { groupHits, snippetParts, type HitGroup, type HostHit } from './lib/results';
import { revealSearchHit } from './lib/reveal';
import {
  SEARCH_DEBOUNCE_MS,
  useContentSearch,
  useSearchHosts,
  type SearchQuery,
} from './lib/use-content-search';

/**
 * The full-text search (WP-115, WP-110 §3.6, ADR-255): one text field, the switches "Include
 * archived" (default on) and "Tool output", the hits of every computer that searches contents mixed
 * by time and grouped by session (title, project, time, computer badge), each with its kind and the
 * snippet with the matches marked. The focus stays in the field (combobox): arrows move, Enter or a
 * click opens the session and jumps to the hit (`revealItem`), Esc closes and gives the focus back.
 * Text and switches survive closing (module memory: the next Ctrl+Shift+F continues).
 */

let remembered: SearchQuery = { text: '', includeArchived: true, includeToolOutput: false };

/** Tests: forget the last text and switches. */
export function resetSearchMemory(): void {
  remembered = { text: '', includeArchived: true, includeToolOutput: false };
}

function Snippet({ hit }: { hit: HostHit }) {
  const parts = useMemo(() => snippetParts(hit.hit.snippet, hit.hit.ranges), [hit]);
  return (
    <span data-slot="search-snippet" className="min-w-0 flex-1 truncate">
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="bg-warning/25 text-foreground rounded-[2px] px-px">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function GroupHeader({
  id,
  group,
  summary,
  labels,
  now,
}: {
  id: string;
  group: HitGroup;
  summary: SessionSummary | undefined;
  labels: HostLabels;
  now: number;
}) {
  const { t, format } = useI18n();
  const label = labels.get(group.hostId);
  return (
    <div
      id={id}
      role="presentation"
      data-slot="search-group-header"
      className="text-muted-foreground flex min-w-0 items-center gap-2 px-2 pt-2 pb-0.5 text-2xs"
    >
      <span className="text-foreground min-w-0 truncate font-medium">
        {summary === undefined ? t('search.unknownSession') : sessionTitle(summary)}
      </span>
      {summary === undefined ? null : (
        <span className="min-w-0 shrink truncate">{pathTail(sessionProjectPath(summary))}</span>
      )}
      {summary?.archived === true ? (
        <Badge variant="outline" className="h-4 px-1 text-2xs">
          {t('search.archived')}
        </Badge>
      ) : null}
      {label === undefined ? null : (
        <HostBadge name={label.name} color={label.color} availability={label.availability} />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
        <span>{t('search.hits', { count: group.hits.length })}</span>
        <span aria-hidden>·</span>
        <span>{format.relative(group.latestAt, now, 'narrow')}</span>
      </span>
    </div>
  );
}

function SearchContent({
  initialText,
  onChoose,
}: {
  initialText: string | null;
  onChoose: (hit: HostHit, summary: SessionSummary | undefined) => void;
}) {
  const { t, tError } = useI18n();
  const [query, setQuery] = useState<SearchQuery>(() =>
    initialText === null ? remembered : { ...remembered, text: initialText },
  );
  // Typing waits for a pause; opening and the switches ask at once.
  const [delay, setDelay] = useState(0);
  const [active, setActive] = useState(0);
  const hosts = useSearchHosts();
  const search = useContentSearch(query, hosts, delay);
  const labels = useHostLabels();
  const entries = useSummaries();
  const now = useNow(30_000);
  const listId = useId();
  const optionsId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    remembered = query;
  }, [query]);

  const summaries = useMemo(
    () => new Map(entries.map((entry) => [entry.sessionKey, entry.summary])),
    [entries],
  );
  const groups = useMemo(() => groupHits(search.hits), [search.hits]);
  const flat = useMemo(() => groups.flatMap((group) => group.hits), [groups]);
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  useEffect(() => {
    if (activeIndex < 0) return;
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${String(activeIndex)}"]`);
    // happy-dom and old engines may lack scrollIntoView.
    if (typeof option?.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const change = (patch: Partial<SearchQuery>, wait: number) => {
    setQuery((previous) => ({ ...previous, ...patch }));
    setDelay(wait);
    setActive(0);
  };
  const choose = (hit: HostHit) => {
    onChoose(hit, summaries.get(hit.sessionKey));
  };

  const text = query.text.trim();
  const status =
    hosts.length === 0
      ? t('search.unavailable')
      : text.length < LIMITS.searchTextMin
        ? t('search.hintShort', { min: LIMITS.searchTextMin })
        : search.phase === 'loading' && flat.length === 0
          ? t('search.searching')
          : search.phase === 'done' && flat.length === 0
            ? t('search.empty')
            : t('search.hits', { count: flat.length });

  return (
    <>
      <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
      <DialogDescription className="sr-only">{t('search.description')}</DialogDescription>
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <TextSearchIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <CommandInput
          listId={listId}
          activeIndex={activeIndex}
          count={flat.length}
          value={query.text}
          maxLength={LIMITS.searchTextMax}
          aria-label={t('search.input')}
          placeholder={t('search.placeholder')}
          data-slot="search-input"
          className="border-0 px-0 shadow-none focus-visible:ring-0"
          onChange={(event) => {
            change({ text: event.target.value }, SEARCH_DEBOUNCE_MS);
          }}
          onKeyDown={(event) => {
            handleCommandKey(event, {
              count: flat.length,
              activeIndex,
              onActiveIndexChange: setActive,
              onSelectActive: () => {
                const hit = flat[activeIndex];
                if (hit !== undefined) choose(hit);
              },
            });
          }}
        />
        {search.phase === 'loading' ? <Spinner label={t('search.searching')} className="shrink-0" /> : null}
      </div>
      <div
        role="group"
        aria-label={t('search.options')}
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5 text-xs"
      >
        <span className="flex items-center gap-1.5">
          <Switch
            id={`${optionsId}-archived`}
            checked={query.includeArchived}
            data-option="include-archived"
            onCheckedChange={(includeArchived) => {
              change({ includeArchived }, 0);
            }}
          />
          <Label htmlFor={`${optionsId}-archived`} className="text-xs font-normal">
            {t('search.includeArchived')}
          </Label>
        </span>
        <span className="flex items-center gap-1.5">
          <Switch
            id={`${optionsId}-tools`}
            checked={query.includeToolOutput}
            data-option="include-tool-output"
            onCheckedChange={(includeToolOutput) => {
              change({ includeToolOutput }, 0);
            }}
          />
          <Label htmlFor={`${optionsId}-tools`} className="text-xs font-normal">
            {t('search.includeToolOutput')}
          </Label>
        </span>
        <span data-slot="search-status" aria-live="polite" className="text-muted-foreground ml-auto text-2xs">
          {status}
        </span>
      </div>
      {search.failures.map(({ hostId, error }) => (
        <Alert key={hostId} tone="warning" role="alert" data-slot="search-failed" className="m-2 mb-0">
          {t('search.failed', {
            host: hostName(labels, hostId, t('search.thisComputer')),
            error: tError(error),
          })}
        </Alert>
      ))}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t('search.results')}
        aria-busy={search.stale || undefined}
        data-slot="search-results"
        className={cn(
          'grid max-h-[min(28rem,60vh)] grid-cols-[minmax(0,1fr)] overflow-y-auto p-1 empty:hidden',
          search.stale && 'opacity-60',
        )}
      >
        {groups.map((group) => {
          const headerId = `${listId}-group-${group.sessionKey}`;
          return (
            <div
              key={group.sessionKey}
              role="group"
              aria-labelledby={headerId}
              data-session={group.sessionKey}
            >
              <GroupHeader
                id={headerId}
                group={group}
                summary={summaries.get(group.sessionKey)}
                labels={labels}
                now={now}
              />
              {group.hits.map((hit, hitIndex) => {
                const own = group.start + hitIndex;
                const selected = own === activeIndex;
                return (
                  <div
                    key={hit.key}
                    id={commandOptionId(listId, own)}
                    role="option"
                    aria-selected={selected}
                    data-index={own}
                    data-active={selected ? '' : undefined}
                    data-kind={hit.hit.kind}
                    // Keep the focus in the search field.
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onMouseMove={() => {
                      if (!selected) setActive(own);
                    }}
                    onClick={() => {
                      choose(hit);
                    }}
                    className={cn(
                      'text-ui flex min-w-0 cursor-default items-center gap-2 rounded-sm px-2 py-1 select-none',
                      selected && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="text-muted-foreground w-20 shrink-0 truncate text-2xs">
                      {t(`search.kind.${hit.hit.kind}`)}
                    </span>
                    <Snippet hit={hit} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <p className="text-muted-foreground border-t px-3 py-1.5 text-2xs">
        {search.truncated ? t('search.truncated', { max: LIMITS.searchHitsMax }) : t('search.hint')}
      </p>
    </>
  );
}

function hostName(labels: HostLabels, hostId: HostId, own: string): string {
  return labels.get(hostId)?.name ?? own;
}

/**
 * The dialog (lazy chunk of the slot `SearchDialog`). `initialText`: the text of `search.open`
 * (null = continue with the last one); `openCount` remounts the content for every request.
 */
export default function SearchDialog({
  open,
  openCount,
  initialText,
  onOpenChange,
}: {
  open: boolean;
  openCount: number;
  initialText: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [, select] = useSelectedSession();
  const chosen = useRef<string | null>(null);
  const returnFocus = useReturnFocus(open);

  const onChoose = useCallback(
    (hit: HostHit, summary: SessionSummary | undefined) => {
      setArchiveView(summary?.archived === true);
      select(hit.sessionKey);
      revealSearchHit({
        kind: 'revealItem',
        sessionKey: hit.sessionKey,
        conversationId: hit.hit.conversationId,
        itemId: hit.hit.itemId,
      });
      chosen.current = hit.sessionKey;
      onOpenChange(false);
    },
    [onOpenChange, select],
  );

  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      const sessionKey = chosen.current;
      chosen.current = null;
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
        <DialogContent
          data-slot="search-dialog"
          showCloseButton={false}
          onCloseAutoFocus={onCloseAutoFocus}
          className="top-[14%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
        >
          <SearchContent key={openCount} initialText={initialText} onChoose={onChoose} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
