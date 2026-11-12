import { FolderTreeIcon, ListTodoIcon, ScrollTextIcon, type LucideIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { BackgroundTask, TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { countRunningTasks, selectTaskSources } from '@web/lib/task-rows';
import { useSessionSelector } from '@web/state/hooks';
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { runAfterMenu } from './navigation/session-actions';
import { requestShell, type SidePanelTab } from './requests';
import { closeSidePanel, getSidePanelTab, openSidePanel, useSidePanelTab } from './side-panel/state';

/**
 * Side panel buttons of the session header (WP-58): "Plan" (once the session has a plan), "Files"
 * and "Tasks" with a counter (running tasks – highlighted, counted like the task panel through
 * `@web/lib/task-rows`, CR3-02 – else open to-dos). A click
 * asks the side panel host (`sidePanel {tab}`); clicking the open tab again closes it. In a narrow
 * header the buttons move into the "…" menu (`HeaderPanelMenuItems`). Outside the `<header>`
 * status line (ADR-042: the header itself has no buttons).
 */

/** Facts the buttons depend on – a narrow selector: deltas of the transcript never re-render them. */
export interface SidePanelFacts {
  /** A stored plan version or a plan file exists: "Plan" is shown. */
  plan: boolean;
  /** Running tasks – the task panel's count (`countRunningTasks`, CR3-02). */
  running: number;
  /** To-dos of the pinned list that are not completed. */
  openTodos: number;
}

const NO_FACTS: SidePanelFacts = { plan: false, running: 0, openTodos: 0 };

/** Last count per background list: the rows are built again only when a task item changed. */
const runningCache = new WeakMap<
  readonly BackgroundTask[],
  { sources: readonly TranscriptItem[]; count: number }
>();

function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function selectRunningTasks(view: SessionViewState): number {
  const background = view.detail.backgroundTasks;
  const sources = selectTaskSources(view);
  const cached = runningCache.get(background);
  if (cached !== undefined && sameItems(cached.sources, sources)) return cached.count;
  const count = countRunningTasks(sources, background);
  runningCache.set(background, { sources, count });
  return count;
}

export function selectSidePanelFacts(view: SessionViewState): SidePanelFacts {
  const { detail } = view;
  let openTodos = 0;
  for (const item of detail.todos?.items ?? []) {
    if (item.status !== 'completed') openTodos += 1;
  }
  return {
    plan: detail.latestPlanVersion !== null || detail.planFile !== null,
    running: selectRunningTasks(view),
    openTodos,
  };
}

export function useSidePanelFacts(sessionKey: string): SidePanelFacts {
  return useSessionSelector(sessionKey, selectSidePanelFacts, NO_FACTS);
}

/**
 * Opens `tab` of the session's side panel, or closes the panel when `tab` is the open one. Without
 * a host serving the request (its SlotBoundary shows an error card) the panel state changes
 * directly – which also gives the failed panel a fresh try (SessionPane).
 */
export function toggleSidePanel(sessionKey: string, tab: SidePanelTab): void {
  const next = getSidePanelTab(sessionKey) === tab ? null : tab;
  if (requestShell({ kind: 'sidePanel', sessionKey, tab: next })) return;
  if (next === null) closeSidePanel(sessionKey);
  else openSidePanel(sessionKey, next);
}

interface PanelButton {
  tab: Extract<SidePanelTab, 'plan' | 'files' | 'tasks'>;
  icon: LucideIcon;
  label: string;
  /** Counter next to the icon (tasks), null = none. */
  count: number | null;
  /** The counter shows running background tasks (highlighted). */
  running: boolean;
}

function usePanelButtons(sessionKey: string): PanelButton[] {
  const t = useT();
  const facts = useSidePanelFacts(sessionKey);
  const plain = { count: null, running: false };
  const buttons: PanelButton[] = [];
  if (facts.plan)
    buttons.push({ tab: 'plan', icon: ScrollTextIcon, label: t('navigation.panels.plan'), ...plain });
  buttons.push({ tab: 'files', icon: FolderTreeIcon, label: t('navigation.panels.files'), ...plain });
  let tasks: Pick<PanelButton, 'label' | 'count' | 'running'>;
  if (facts.running > 0) {
    const count = facts.running;
    tasks = { label: t('navigation.panels.tasksRunning', { count }), count, running: true };
  } else if (facts.openTodos > 0) {
    const count = facts.openTodos;
    tasks = { label: t('navigation.panels.tasksOpen', { count }), count, running: false };
  } else {
    tasks = { label: t('navigation.panels.tasks'), ...plain };
  }
  buttons.push({ tab: 'tasks', icon: ListTodoIcon, ...tasks });
  return buttons;
}

/** Larger counts show as "99+" (`navigation.panels.countOverflow`, R5W-06). */
export const PANEL_COUNTER_MAX = 99;

function Counter({ count, running }: { count: number; running: boolean }) {
  const t = useT();
  return (
    <span
      aria-hidden
      data-slot="header-panel-count"
      data-running={running ? 'true' : undefined}
      className={cn(
        'min-w-3.5 rounded-sm px-0.5 text-center text-2xs leading-4 font-semibold tabular-nums',
        running ? 'bg-status-working/15 text-status-working' : 'text-muted-foreground',
      )}
    >
      {count > PANEL_COUNTER_MAX ? t('navigation.panels.countOverflow', { max: PANEL_COUNTER_MAX }) : count}
    </span>
  );
}

/** The buttons as a group next to the "…" menu (wide header). */
export function HeaderPanelButtons({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const open = useSidePanelTab(sessionKey);
  const buttons = usePanelButtons(sessionKey);
  return (
    <div
      role="group"
      aria-label={t('navigation.panels.label')}
      data-slot="header-panels"
      className="flex items-center gap-0.5"
    >
      {buttons.map((button) => {
        const Icon = button.icon;
        return (
          <IconButton
            key={button.tab}
            label={button.label}
            tooltipSide="bottom"
            aria-pressed={open === button.tab}
            data-slot="header-panel"
            data-tab={button.tab}
            size={button.count === null ? 'icon-sm' : 'sm'}
            className={cn(
              'text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground',
              button.count !== null && 'gap-0.5 px-1',
            )}
            onClick={() => {
              toggleSidePanel(sessionKey, button.tab);
            }}
          >
            <Icon aria-hidden />
            {button.count === null ? null : <Counter count={button.count} running={button.running} />}
          </IconButton>
        );
      })}
    </div>
  );
}

/**
 * The buttons as checkbox items at the top of the "…" menu (narrow header). The panel opens once
 * the menu has closed, with the "…" button as its opener (focus returns there).
 */
export function HeaderPanelMenuItems({ sessionKey }: { sessionKey: string }) {
  const open = useSidePanelTab(sessionKey);
  const buttons = usePanelButtons(sessionKey);
  return (
    <>
      {buttons.map((button) => {
        const Icon = button.icon;
        return (
          <DropdownMenuCheckboxItem
            key={button.tab}
            checked={open === button.tab}
            data-action={`panel-${button.tab}`}
            onSelect={() => {
              runAfterMenu(sessionKey, () => {
                toggleSidePanel(sessionKey, button.tab);
              });
            }}
          >
            <Icon aria-hidden />
            {button.label}
          </DropdownMenuCheckboxItem>
        );
      })}
      <DropdownMenuSeparator />
    </>
  );
}

/** Width of the session bar (px) below which the panel buttons move into the "…" menu. */
export const COMPACT_HEADER_BELOW = 560;

/**
 * Measures the session bar: `[compact, ref]` – compact while the bar is narrower than
 * COMPACT_HEADER_BELOW (unknown width, e.g. without ResizeObserver: wide).
 */
export function useCompactHeader(): [boolean, (element: HTMLElement | null) => (() => void) | undefined] {
  const [compact, setCompact] = useState(false);
  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width ?? 0;
      setCompact(width > 0 && width < COMPACT_HEADER_BELOW);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [compact, ref];
}
