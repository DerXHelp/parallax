/**
 * WP-71 "what runs where" in the sidebar: the pulsing status of working and background sessions
 * (row and rail), the running tasks next to the title (agent and terminal symbol + number), the
 * "Running now" section of the row's tooltip and the counters in the header.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunningTasks, SessionSummary } from '@shared/model';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import {
  RUNNING_DEMO_ENTRIES,
  RUNNING_DEMO_SESSION_KEYS,
  RUNNING_DEMO_TASKS,
} from '@web/playground/running-scenario';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { installShortcutListener } from '../shortcuts';
import { resetSidebarLayout } from '../sidebar-layout';
import { resetRename } from './rename';
import { resetSidebarView } from './sidebar-view';

vi.setConfig({ testTimeout: 60_000 });

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];
const originalWidth = window.innerWidth;

function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetSidebarLayout();
  setWindowWidth(1280);
});

afterEach(() => {
  act(() => {
    resetRename();
    resetSidebarView();
    setLanguage('en');
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  localStorage.clear();
  sessionStorage.clear();
  resetSidebarLayout();
  setWindowWidth(originalWidth);
});

async function startShell(): Promise<RunningScenario> {
  running = startScenario('navigation-running');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  const nav = await screen.findByRole('navigation', { name: 'Sessions' });
  await within(nav).findByText('Landing page copy');
  return running;
}

function row(sessionKey: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]`);
  if (element === null) throw new Error(`row ${sessionKey} missing`);
  return element;
}

/** `{group: number}` of the counters in `root` ("9+" stays text). */
function counts(root: Element | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const span of root?.querySelectorAll<HTMLElement>('[data-slot="running-count"]') ?? []) {
    result[span.dataset.group ?? '?'] = span.textContent;
  }
  return result;
}

function rowTasks(sessionKey: string): HTMLElement | null {
  return row(sessionKey).querySelector<HTMLElement>('[data-slot="row-tasks"]');
}

function pulseOf(root: Element): string | null {
  return root.querySelector<HTMLElement>('[data-slot="status-icon"]')?.dataset.pulse ?? null;
}

function patch(
  scenario: RunningScenario,
  entryId: SessionSummary['entryId'],
  p: Partial<SessionSummary>,
  status: Partial<SessionSummary['status']> = {},
): void {
  act(() => {
    scenario.host.patchSummary(entryId, p, status);
  });
}

describe('running tasks in the sidebar row (WP-71)', () => {
  it('agents and shells next to the title, named for screen readers; working pulses strong, background soft', async () => {
    await startShell();
    const working = RUNNING_DEMO_SESSION_KEYS.working;
    await waitFor(() => {
      expect(counts(rowTasks(working))).toEqual({ agents: '2', shells: '1' });
    });
    expect(rowTasks(working)?.className).toContain('text-status-working');
    expect(within(row(working)).getByText('Running: 2 agents and 1 shell').className).toContain('sr-only');
    // The symbols themselves are decoration: the counter group is hidden from screen readers.
    expect(
      rowTasks(working)?.querySelector('[data-slot="running-count"]')?.closest('[aria-hidden]'),
    ).not.toBeNull();
    expect(pulseOf(row(working))).toBe('strong');
    // One animation per row: the pulse replaces the spin.
    expect(row(working).querySelector('.motion-safe\\:animate-spin')).toBeNull();

    const background = RUNNING_DEMO_SESSION_KEYS.background;
    expect(counts(rowTasks(background))).toEqual({ shells: '1' });
    expect(pulseOf(row(background))).toBe('soft');

    const resting = NAVIGATION_SESSION_KEYS.landing;
    expect(rowTasks(resting)).toBeNull();
    expect(pulseOf(row(resting))).toBeNull();
  });

  it('the counters follow the summary and vanish once nothing runs; large numbers read "9+"', async () => {
    const scenario = await startShell();
    const working = RUNNING_DEMO_SESSION_KEYS.working;
    const many: RunningTasks = { agents: 12, shells: 0, other: 1, items: RUNNING_DEMO_TASKS.working.items };
    patch(scenario, RUNNING_DEMO_ENTRIES.working, { runningTasks: many });
    await waitFor(() => {
      expect(counts(rowTasks(working))).toEqual({ agents: '9+', misc: '1' });
    });
    patch(
      scenario,
      RUNNING_DEMO_ENTRIES.working,
      { runningTasks: null },
      { runState: 'idle', backgroundTasks: 0 },
    );
    await waitFor(() => {
      expect(rowTasks(working)).toBeNull();
    });
    expect(pulseOf(row(working))).toBeNull();
  });

  it('"Running now" in the row tooltip: kind, agent type and label, then "and n more"; German words', async () => {
    const scenario = await startShell();
    const working = RUNNING_DEMO_SESSION_KEYS.working;
    const user = userEvent.setup();
    await user.hover(row(working));
    const detail = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="row-tasks-detail"]');
      if (element === null) throw new Error('detail missing');
      return element;
    });
    expect(within(detail).getByText('Running now')).toBeTruthy();
    const entries = [...detail.querySelectorAll<HTMLElement>('[data-slot="row-task"]')];
    expect(entries.map((entry) => entry.dataset.kind)).toEqual(['agent', 'agent', 'bash']);
    expect(entries[0]?.textContent).toBe('Agent·general-purpose:Reading the API handlers');
    expect(entries[2]?.textContent).toBe('Shell:Start the dev server');
    expect(detail.textContent).not.toContain('more');
    await user.unhover(row(working));

    // Seven tasks, five listed: "and 2 more".
    const items = [
      ...RUNNING_DEMO_TASKS.working.items,
      { kind: 'workflow' as const, subagentType: null, label: 'Nightly' },
      { kind: 'other' as const, subagentType: null, label: 'Monitor' },
    ];
    patch(scenario, RUNNING_DEMO_ENTRIES.working, {
      runningTasks: { agents: 4, shells: 2, other: 1, items },
    });
    act(() => {
      setLanguage('de');
    });
    await user.hover(row(working));
    await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="row-tasks-detail"]');
      expect(element?.textContent).toContain('Läuft gerade');
      expect(element?.textContent).toContain('und 2 weitere');
    });
    const german = document.querySelector<HTMLElement>('[data-slot="row-tasks-detail"]');
    expect(german?.querySelectorAll('[data-slot="row-task"]')).toHaveLength(5);
    expect(german?.textContent).toContain('Aufgabe:Monitor');
    expect(
      within(row(working)).getByText('Es läuft: 4 Agenten, 2 Shells und 1 weitere Aufgabe'),
    ).toBeTruthy();
  });
});

describe('running tasks in the rail and the header (WP-71)', () => {
  it('the rail pulses like the row', async () => {
    await startShell();
    setWindowWidth(700);
    const rail = await screen.findByRole('navigation', { name: 'Sessions (collapsed sidebar)' });
    const button = (key: string) => {
      const element = rail.querySelector<HTMLElement>(`[data-rail-session="${key}"]`);
      if (element === null) throw new Error(`rail button ${key} missing`);
      return element;
    };
    expect(pulseOf(button(RUNNING_DEMO_SESSION_KEYS.working))).toBe('strong');
    expect(pulseOf(button(RUNNING_DEMO_SESSION_KEYS.background))).toBe('soft');
    expect(pulseOf(button(NAVIGATION_SESSION_KEYS.landing))).toBeNull();
  });

  it('the header counts the running tasks of the selected session by kind', async () => {
    await startShell();
    const button = await screen.findByRole('button', { name: 'Tasks – running: 2 agents and 1 shell' });
    const pill = button.querySelector<HTMLElement>('[data-slot="header-panel-count"]');
    expect(pill?.dataset.running).toBe('true');
    expect(counts(pill)).toEqual({ agents: '2', shells: '1' });
  });
});
