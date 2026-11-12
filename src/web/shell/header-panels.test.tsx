import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { BackgroundTask, SessionDetail } from '@shared/model';
import {
  SAMPLE_IDS,
  sampleDetail,
  sampleHostState,
  samplePlanFileRef,
  sampleSessionSnapshot,
  sampleSummary,
  sampleTodoList,
} from '@shared/samples';
import { viewStateFromSnapshot } from '@shared/sync';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { COMPACT_HEADER_BELOW, selectSidePanelFacts } from './header-panels';
import { registerShellRequestHandler, type ShellRequestOf } from './requests';
import { SessionHeader } from './SessionHeader';
import { getSidePanelTab, openSidePanel, resetSidePanelState } from './side-panel/state';

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);

function task(n: number): BackgroundTask {
  return {
    taskId: `task-${String(n)}`,
    taskType: 'local_bash',
    description: `npm run watch ${String(n)}`,
    subagentType: null,
    parentTaskId: null,
    ambient: false,
  };
}

function show(detail: Partial<SessionDetail>): void {
  clientStore.setState({
    hosts: {
      [LOCAL_HOST_ID]: {
        ...emptyHostRecord(LOCAL_HOST_ID),
        hostState: sampleHostState(),
        summaries: { [SAMPLE_IDS.entry]: sampleSummary() },
      },
    },
    sessions: {
      [KEY]: {
        view: viewStateFromSnapshot(sampleSessionSnapshot({ detail: sampleDetail(detail) })),
        unavailable: null,
        loading: false,
      },
    },
  });
}

function renderHeader() {
  return render(
    <TooltipProvider>
      <section data-session-key={KEY}>
        <SessionHeader sessionKey={KEY} />
      </section>
    </TooltipProvider>,
  );
}

function panelButtons(): HTMLElement[] {
  const group = screen.queryByRole('group', { name: 'Side panel' });
  return group === null ? [] : within(group).getAllByRole('button');
}

/** Collects the `sidePanel` requests (taken, like the host does). */
function captureRequests(): ShellRequestOf<'sidePanel'>[] {
  const requests: ShellRequestOf<'sidePanel'>[] = [];
  cleanups.push(
    registerShellRequestHandler('sidePanel', (request) => {
      requests.push(request);
      return true;
    }),
  );
  return requests;
}

let barWidth = 1200;
let originalResizeObserver: typeof ResizeObserver;
const cleanups: (() => void)[] = [];

/** happy-dom does not lay out: every observed element reports `barWidth`. */
class BarResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: {
            width: barWidth,
            height: 36,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: barWidth,
            bottom: 36,
            toJSON: () => ({}),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
  unobserve(): void {
    // The stub reports once on observe.
  }
  disconnect(): void {
    // The stub reports once on observe.
  }
}

beforeEach(() => {
  barWidth = 1200;
  originalResizeObserver = window.ResizeObserver;
  window.ResizeObserver = BarResizeObserver;
  globalThis.ResizeObserver = BarResizeObserver;
});

afterEach(() => {
  cleanup();
  for (const done of cleanups.splice(0)) done();
  window.ResizeObserver = originalResizeObserver;
  globalThis.ResizeObserver = originalResizeObserver;
  resetSidePanelState();
  resetClientStore();
});

describe('selectSidePanelFacts', () => {
  it('plan from a stored version or a plan file; background tasks; open to-dos', () => {
    const facts = (detail: Partial<SessionDetail>) =>
      selectSidePanelFacts(viewStateFromSnapshot(sampleSessionSnapshot({ detail: sampleDetail(detail) })));
    expect(facts({})).toEqual({ plan: false, background: 0, openTodos: 0 });
    expect(facts({ latestPlanVersion: 2 }).plan).toBe(true);
    expect(facts({ planFile: samplePlanFileRef() }).plan).toBe(true);
    expect(facts({ backgroundTasks: [task(1), task(2)] }).background).toBe(2);
    // sampleTodoList: one completed, one in progress, one pending.
    expect(facts({ todos: sampleTodoList() }).openTodos).toBe(2);
  });
});

describe('header side panel buttons (WP-58)', () => {
  it('"Files" and "Tasks" always, "Plan" once the session has a plan – outside the status line', () => {
    show({});
    const { rerender } = renderHeader();
    expect(panelButtons().map((button) => button.getAttribute('data-tab'))).toEqual(['files', 'tasks']);
    expect(screen.getByRole('button', { name: 'Files of this session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeTruthy();
    // ADR-042: the <header> status line has no buttons.
    const header = document.querySelector<HTMLElement>('[data-slot="session-header"]');
    expect(header === null ? -1 : within(header).queryAllByRole('button')).toHaveLength(0);

    act(() => {
      show({ latestPlanVersion: 1 });
    });
    rerender(
      <TooltipProvider>
        <section data-session-key={KEY}>
          <SessionHeader sessionKey={KEY} />
        </section>
      </TooltipProvider>,
    );
    expect(panelButtons().map((button) => button.getAttribute('data-tab'))).toEqual([
      'plan',
      'files',
      'tasks',
    ]);
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
  });

  it('a plan file alone shows "Plan" too', () => {
    show({ planFile: samplePlanFileRef() });
    renderHeader();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
  });

  it('counts running background tasks (highlighted) before open to-dos', () => {
    show({ backgroundTasks: [task(1), task(2)], todos: sampleTodoList() });
    renderHeader();
    const tasks = screen.getByRole('button', { name: 'Tasks – 2 background tasks running' });
    const count = tasks.querySelector<HTMLElement>('[data-slot="header-panel-count"]');
    expect(count?.textContent).toBe('2');
    expect(count?.dataset.running).toBe('true');
    expect(count?.className).toContain('text-status-working');
  });

  it('without background tasks it counts the open to-dos (not highlighted)', () => {
    show({ todos: sampleTodoList() });
    renderHeader();
    const tasks = screen.getByRole('button', { name: 'Tasks – 2 open to-dos' });
    const count = tasks.querySelector<HTMLElement>('[data-slot="header-panel-count"]');
    expect(count?.textContent).toBe('2');
    expect(count?.dataset.running).toBeUndefined();
  });

  it('one background task: singular text', () => {
    show({ backgroundTasks: [task(1)] });
    renderHeader();
    expect(screen.getByRole('button', { name: 'Tasks – 1 background task running' })).toBeTruthy();
  });

  it('a click asks for the tab; the open tab is pressed and a second click closes it', async () => {
    show({ latestPlanVersion: 3 });
    const requests = captureRequests();
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Files of this session' }));
    expect(requests).toEqual([{ kind: 'sidePanel', sessionKey: KEY, tab: 'files' }]);

    // The host opened the tab: the button shows it, a click closes the panel.
    act(() => {
      openSidePanel(KEY, 'files');
    });
    const files = screen.getByRole('button', { name: 'Files of this session' });
    expect(files.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Plan' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(files);
    expect(requests.at(-1)).toEqual({ kind: 'sidePanel', sessionKey: KEY, tab: null });
    await user.click(screen.getByRole('button', { name: 'Plan' }));
    expect(requests.at(-1)).toEqual({ kind: 'sidePanel', sessionKey: KEY, tab: 'plan' });
  });

  it('without a host serving the request (failed panel) the panel state changes directly', async () => {
    show({});
    const user = userEvent.setup();
    renderHeader();
    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(getSidePanelTab(KEY)).toBe('tasks');
    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    expect(getSidePanelTab(KEY)).toBeNull();
  });

  it(`a narrow bar (< ${String(COMPACT_HEADER_BELOW)} px) moves them into the "…" menu`, async () => {
    barWidth = COMPACT_HEADER_BELOW - 1;
    show({ latestPlanVersion: 1, backgroundTasks: [task(1)] });
    const requests = captureRequests();
    const user = userEvent.setup();
    renderHeader();
    expect(screen.queryByRole('group', { name: 'Side panel' })).toBeNull();
    expect(document.querySelector('[data-slot="session-bar"]')?.getAttribute('data-compact')).toBe('true');

    const trigger = screen.getByRole('button', { name: 'Session actions' });
    await user.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitemcheckbox');
    expect(items.map((item) => item.textContent)).toEqual([
      'Plan',
      'Files of this session',
      'Tasks – 1 background task running',
    ]);
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Files of this session' }));
    await waitFor(() => {
      expect(requests).toEqual([{ kind: 'sidePanel', sessionKey: KEY, tab: 'files' }]);
    });
    // The request ran after the menu closed, with the focus back on "…" (the panel's opener).
    expect(document.activeElement).toBe(trigger);

    act(() => {
      openSidePanel(KEY, 'files');
    });
    await user.click(trigger);
    const reopened = await screen.findByRole('menu');
    expect(
      within(reopened)
        .getByRole('menuitemcheckbox', { name: 'Files of this session' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('a wide bar keeps the buttons and the menu without panel items', async () => {
    show({});
    const user = userEvent.setup();
    renderHeader();
    expect(panelButtons()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryAllByRole('menuitemcheckbox')).toHaveLength(0);
  });
});
