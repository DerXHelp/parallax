import { FunnelXIcon, SearchIcon, XIcon } from 'lucide-react';
import { useMemo, type KeyboardEvent } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { focusElement } from '@web/lib/return-focus';
import {
  SIDEBAR_STATUS_FILTERS,
  sidebarFilterActive,
  sidebarFilterCounts,
  type SidebarFilter,
  type SidebarStatusFilter,
} from '@web/lib/session-order';
import { useNow } from '@web/state/clock';
import { useSummaries } from '@web/state/hooks';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Input } from '@web/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';
import {
  clearSidebarFilter,
  setSidebarFilter,
  SIDEBAR_FILTER_TEXT_MAX,
  useArchiveView,
  useSidebarFilter,
} from './sidebar-view';

/**
 * WP-115 (F6, WP-110 §3.7): the filter above the sidebar list – a text field (title, folder,
 * branch; every word must occur) and the status buttons "All", "Waiting", "Working", "Unread" with
 * their counters. Window-local (`sidebar-view.ts`); the list itself filters through
 * `useSidebarLayout`, so the sidebar, Alt+1…9 and the rail show the same entries. Hidden in the
 * archive view (the archive is not filtered).
 * Keys in the text field: Esc clears the text (then leaves the field to the overlay's Esc), ArrowDown
 * moves to the list.
 */

function isStatusFilter(value: string): value is SidebarStatusFilter {
  return (SIDEBAR_STATUS_FILTERS as readonly string[]).includes(value);
}

/** The list's tab stop (the selected row, else the first) inside the same sidebar. */
function listTabStop(from: HTMLElement): HTMLElement | null {
  const sidebar = from.closest('aside') ?? document;
  return sidebar.querySelector<HTMLElement>(
    '[data-session-row][tabindex="0"], [data-group-toggle][tabindex="0"]',
  );
}

export function SidebarFilterBar({ className }: { className?: string }) {
  const t = useT();
  const archive = useArchiveView();
  const filter = useSidebarFilter();
  const entries = useSummaries();
  const now = useNow(30_000);
  const counts = useMemo(() => sidebarFilterCounts(entries, new Date(now)), [entries, now]);
  if (archive) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && filter.text !== '') {
      event.preventDefault();
      event.stopPropagation();
      setSidebarFilter({ text: '' });
      return;
    }
    if (event.key === 'ArrowDown' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (focusElement(listTabStop(event.currentTarget))) event.preventDefault();
    }
  };

  return (
    <div
      role="search"
      aria-label={t('navigation.filter.label')}
      data-slot="sidebar-filter"
      data-active={sidebarFilterActive(filter) || undefined}
      className={cn('mx-1.5 mb-1 grid shrink-0 gap-1', className)}
    >
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
        />
        <Input
          value={filter.text}
          maxLength={SIDEBAR_FILTER_TEXT_MAX}
          aria-label={t('navigation.filter.text')}
          placeholder={t('navigation.filter.placeholder')}
          autoComplete="off"
          spellCheck={false}
          data-slot="sidebar-filter-text"
          className="h-7 pr-7 pl-7 text-xs"
          onChange={(event) => {
            setSidebarFilter({ text: event.target.value });
          }}
          onKeyDown={onKeyDown}
        />
        {filter.text === '' ? null : (
          <IconButton
            label={t('navigation.filter.clearText')}
            size="icon-xs"
            data-action="clear-filter-text"
            className="absolute top-1/2 right-0.5 -translate-y-1/2"
            onClick={() => {
              setSidebarFilter({ text: '' });
            }}
          >
            <XIcon aria-hidden />
          </IconButton>
        )}
      </div>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        aria-label={t('navigation.filter.statusLabel')}
        value={filter.status}
        className="w-full"
        onValueChange={(value) => {
          // Radix sends '' when the pressed button is pressed again: one button stays pressed.
          if (isStatusFilter(value)) setSidebarFilter({ status: value });
        }}
      >
        {SIDEBAR_STATUS_FILTERS.map((status) => (
          <ToggleGroupItem key={status} value={status} data-filter={status} className="gap-1 px-1 text-2xs">
            <span className="truncate">{t(`navigation.filter.status.${status}`)}</span>
            {status === 'all' || counts[status] === 0 ? null : (
              <span data-slot="filter-count" className="shrink-0 tabular-nums opacity-70">
                {counts[status]}
              </span>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Text of an active filter ("Waiting · “login”"). */
function useFilterText(filter: SidebarFilter): string {
  const t = useT();
  const parts: string[] = [];
  if (filter.status !== 'all') parts.push(t(`navigation.filter.status.${filter.status}`));
  const text = filter.text.trim();
  if (text !== '') parts.push(t('navigation.filter.quoted', { text }));
  return parts.join(t('navigation.filter.separator'));
}

/** The list is empty because of the filter: says so and offers to reset it. */
export function SidebarFilterEmpty() {
  const t = useT();
  const filter = useSidebarFilter();
  const description = useFilterText(filter);
  return (
    <div data-slot="sidebar-filter-empty" className="grid justify-items-start gap-1.5 px-2 py-3 text-xs">
      <p className="text-muted-foreground">{t('navigation.filter.empty', { filter: description })}</p>
      <Button variant="outline" size="sm" data-action="reset-filter" onClick={clearSidebarFilter}>
        <FunnelXIcon aria-hidden />
        {t('navigation.filter.reset')}
      </Button>
    </div>
  );
}

/**
 * The rail of a collapsed sidebar lists what the filter keeps (same layout): this button says that a
 * filter is active (which one in its name and tooltip) and shows every session again.
 */
export function RailFilterIndicator() {
  const t = useT();
  const filter = useSidebarFilter();
  const description = useFilterText(filter);
  if (!sidebarFilterActive(filter)) return null;
  return (
    <IconButton
      label={t('navigation.filter.railActive', { filter: description })}
      tooltipSide="right"
      size="icon"
      data-action="rail-clear-filter"
      className="text-brand"
      onClick={clearSidebarFilter}
    >
      <FunnelXIcon aria-hidden />
    </IconButton>
  );
}
