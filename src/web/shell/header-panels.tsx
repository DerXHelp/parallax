import { FolderTreeIcon, ListTodoIcon, ScrollTextIcon, type LucideIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { BackgroundTask, TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { buildTaskRows, runningTaskCounts, runningTaskTotal, type RunningTaskCounts } from '@shared/tasks';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { selectTaskSources } from '@web/lib/task-rows';
import { useSessionSelector } from '@web/state/hooks';
import { DropdownMenuCheckboxItem, DropdownMenuSeparator } from '@web/ui/dropdown-menu';
import { IconButton } from '@web/ui/icon-button';
import { runAfterMenu } from './navigation/session-actions';
import { requestShell, type SidePanelTab } from './requests';
import { RunningCounts, useRunningWords } from './running-tasks';
import { closeSidePanel, getSidePanelTab, openSidePanel, useSidePanelTab } from './side-panel/state';

/**
 * Side panel buttons of the session header (WP-58): "Plan" (once the session has a plan), "Files"
 * and "Tasks" with a counter – WP-71: the running tasks by kind (agent symbol + number, terminal
 * symbol + number, the rest; highlighted, counted like the task panel through `@shared/tasks`,
 * CR3-02), else the open to-dos. A click
 * asks the side panel host (`sidePanel {tab}`); clicking the open tab again closes it. In a narrow
 * header the buttons move into the "…" menu (`HeaderPanelMenuItems`). Outside the `<header>`
 * status line (ADR-042: the header itself has no buttons).
 */

/**
 * Facts the buttons depend on – a narrow selector of primitives: deltas of the transcript never
 * re-render them. `agents`/`shells`/`other` = running tasks by kind (the task panel's rows,
 * `runningTaskCounts`, CR3-02, WP-71).
 */
export interface SidePanelFacts extends RunningTaskCounts {
  /** A stored plan version or a plan file exists: "Plan" is shown. */
  plan: boolean;
  /** To-dos of the pinned list that are not completed. */
  openTodos: number;
}

const NO_FACTS: SidePanelFacts = { plan: false, agents: 0, shells: 0, other: 0, openTodos: 0 };

/** Last counts per background list: the rows are built again only when a task item changed. */
const runningCache = new WeakMap<
  readonly BackgroundTask[],
  { sources: readonly TranscriptItem[]; counts: RunningTaskCounts }
>();

function sameItems(a: readonly TranscriptItem[], b: readonly TranscriptItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function selectRunningTasks(view: SessionViewState): RunningTaskCounts {
  const background = view.detail.backgroundTasks;
  const sources = selectTaskSources(view);
  const cached = runningCache.get(background);
  if (cached !== undefined && sameItems(cached.sources, sources)) return cached.counts;
  const counts = runningTaskCounts(buildTaskRows(sources, background));
  runningCache.set(background, { sources, counts });
  return counts;
}

export function selectSidePanelFacts(view: SessionViewState): SidePanelFacts {
  const { detail } = view;
  let openTodos = 0;
  for (const item of detail.todos?.items ?? []) {
    if (item.status !== 'completed') openTodos += 1;
  }
  const { agents, shells, other } = selectRunningTasks(view);
  return {
    plan: detail.latestPlanVersion !== null || detail.planFile !== null,
    agents,
    shells,
    other,
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
  /** Counter next to the icon (open to-dos), null = none. */
  count: number | null;
  /** WP-71: running tasks by kind (highlighted counters instead of `count`), null = none run. */
  running: RunningTaskCounts | null;
}

function usePanelButtons(sessionKey: string): PanelButton[] {
  const t = useT();
  const facts = useSidePanelFacts(sessionKey);
  const words = useRunningWords(facts);
  const plain = { count: null, running: null };
  const buttons: PanelButton[] = [];
  if (facts.plan)
    buttons.push({ tab: 'plan', icon: ScrollTextIcon, label: t('navigation.panels.plan'), ...plain });
  buttons.push({ tab: 'files', icon: FolderTreeIcon, label: t('navigation.panels.files'), ...plain });
  let tasks: Pick<PanelButton, 'label' | 'count' | 'running'>;
  if (runningTaskTotal(facts) > 0) {
    const { agents, shells, other } = facts;
    tasks = {
      label: t('navigation.panels.tasksRunning', { list: words }),
      count: null,
      running: { agents, shells, other },
    };
  } else if (facts.openTodos > 0) {
    const count = facts.openTodos;
    tasks = { label: t('navigation.panels.tasksOpen', { count }), count, running: null };
  } else {
    tasks = { label: t('navigation.panels.tasks'), ...plain };
  }
  buttons.push({ tab: 'tasks', icon: ListTodoIcon, ...tasks });
  return buttons;
}

/** Larger counts show as "99+" (`navigation.panels.countOverflow`, R5W-06). */
export const PANEL_COUNTER_MAX = 99;

const COUNTER_CLASS = 'min-w-3.5 rounded-sm px-0.5 text-center text-2xs leading-4 font-semibold tabular-nums';

/** Open to-dos (quiet) or – WP-71 – the running tasks by kind (highlighted). */
function Counter({ button }: { button: PanelButton }) {
  const t = useT();
  if (button.running !== null) {
    return (
      <span
        aria-hidden
        data-slot="header-panel-count"
        data-running="true"
        className={cn(COUNTER_CLASS, 'bg-status-working/15 text-status-working flex items-center')}
      >
        <RunningCounts counts={button.running} max={PANEL_COUNTER_MAX} className="gap-1" />
      </span>
    );
  }
  if (button.count === null) return null;
  const count = button.count;
  return (
    <span aria-hidden data-slot="header-panel-count" className={cn(COUNTER_CLASS, 'text-muted-foreground')}>
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
        const counted = button.count !== null || button.running !== null;
        return (
          <IconButton
            key={button.tab}
            label={button.label}
            tooltipSide="bottom"
            aria-pressed={open === button.tab}
            data-slot="header-panel"
            data-tab={button.tab}
            size={counted ? 'sm' : 'icon-sm'}
            className={cn(
              'text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground',
              counted && 'gap-0.5 px-1',
            )}
            onClick={() => {
              toggleSidePanel(sessionKey, button.tab);
            }}
          >
            <Icon aria-hidden />
            <Counter button={button} />
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
