/**
 * WP-65 in the shell: the quiet session line in the sidebar row and the header (§1.1: live sentence,
 * Parallax's fallback words, turn summary, "needs you"), "Generate title again" in the session menu
 * (§1.3) and the reset time of a limit bar as relative time in its tooltip (§1.4).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { SessionSummary, TurnSummary } from '@shared/model';
import {
  SAMPLE_IDS,
  sampleHostState,
  sampleProfileSummary,
  sampleRateLimitInfo,
  sampleSummary,
  sampleTime,
} from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { AppShell } from '../AppShell';
import { SessionHeader } from '../SessionHeader';
import { installShortcutListener } from '../shortcuts';
import { AccountLimits } from './AccountLimits';
import { resetRename } from './rename';
import { resetSidebarView } from './sidebar-view';

vi.setConfig({ testTimeout: 60_000 });

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

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
});

const SUMMARY: TurnSummary = {
  source: 'claude',
  text: 'Fixed the redirect loop; tests pass.',
  category: 'completed',
  needsAction: false,
  at: sampleTime(10),
};

function row(sessionKey: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]`);
  if (element === null) throw new Error(`row ${sessionKey} missing`);
  return element;
}

function rowLine(sessionKey: string): HTMLElement | null {
  return row(sessionKey).querySelector<HTMLElement>('[data-slot="session-line"]');
}

async function startShell(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  const nav = await screen.findByRole('navigation', { name: 'Sessions' });
  await within(nav).findByText('Landing page copy');
  return running;
}

function patch(scenario: RunningScenario, p: Partial<SessionSummary>): void {
  act(() => {
    scenario.host.patchSummary(NAVIGATION_ENTRIES.auth, p);
  });
}

describe('session line in the sidebar row (WP-65 §1.1)', () => {
  it('live sentence, Parallax words while no sentence comes, then the summary; nothing before', async () => {
    const scenario = await startShell();
    const key = NAVIGATION_SESSION_KEYS.auth;
    expect(rowLine(key)).toBeNull();
    patch(scenario, { activity: { kind: 'tool', tool: 'Write', target: 'handy.txt' } });
    await waitFor(() => {
      expect(rowLine(key)?.textContent).toBe('Writing handy.txt');
    });
    patch(scenario, { activity: { kind: 'tool', tool: 'Bash', target: 'pnpm test' } });
    await waitFor(() => {
      expect(rowLine(key)?.textContent).toBe('Running: pnpm test');
    });
    patch(scenario, { activity: { kind: 'tool', tool: 'mcp__github__search', target: null } });
    await waitFor(() => {
      expect(rowLine(key)?.textContent).toBe('Using search · MCP github');
    });
    patch(scenario, { activity: { kind: 'thinking' } });
    await waitFor(() => {
      expect(rowLine(key)?.textContent).toBe('Thinking…');
    });
    patch(scenario, { activity: { kind: 'claude', text: 'Reading the project notes' } });
    await waitFor(() => {
      expect(rowLine(key)?.textContent).toBe('Reading the project notes');
    });
    patch(scenario, { activity: null, turnSummary: SUMMARY });
    await waitFor(() => {
      expect(rowLine(key)?.dataset.line).toBe('summary');
    });
    expect(rowLine(key)?.textContent).toBe(SUMMARY.text);
    expect(rowLine(key)?.dataset.attention).toBeUndefined();
  });

  it('"needs you" is highlighted with a symbol and a screen-reader prefix (not color alone); German words', async () => {
    const scenario = await startShell();
    const key = NAVIGATION_SESSION_KEYS.auth;
    patch(scenario, { turnSummary: { ...SUMMARY, needsAction: true, text: 'Waiting for your review.' } });
    await waitFor(() => {
      expect(rowLine(key)?.dataset.attention).toBe('true');
    });
    const line = rowLine(key);
    expect(line?.className).toContain('text-status-waiting');
    expect(line?.querySelector('svg')).not.toBeNull();
    expect(line?.textContent).toBe('Needs you:Waiting for your review.');
    act(() => {
      setLanguage('de');
    });
    patch(scenario, { activity: { kind: 'tool', tool: 'Read', target: 'notes.md' } });
    await waitFor(() => {
      expect(rowLine(key)?.textContent).toBe('Liest notes.md');
    });
  });

  it('"Generate title again" in the session menu sends session.regenerateTitle', async () => {
    const scenario = await startShell();
    const key = NAVIGATION_SESSION_KEYS.auth;
    fireEvent.contextMenu(row(key));
    const menu = await screen.findByRole('menu');
    await userEvent.setup().click(within(menu).getByRole('menuitem', { name: 'Generate title again' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({ name: 'session.regenerateTitle', entryId: NAVIGATION_ENTRIES.auth });
    });
  });
});

describe('session line in the header (WP-65 §1.1)', () => {
  function renderHeader(summary: SessionSummary): void {
    clientStore.setState({
      hosts: {
        [LOCAL_HOST_ID]: {
          ...emptyHostRecord(LOCAL_HOST_ID),
          hostState: sampleHostState(),
          summaries: { [SAMPLE_IDS.entry]: summary },
        },
      },
    });
    render(
      <TooltipProvider>
        <SessionHeader sessionKey={makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry)} />
      </TooltipProvider>,
    );
  }

  it('the same line after the badges, the whole text as the native tooltip; none without one', () => {
    renderHeader(sampleSummary({ turnSummary: SUMMARY }));
    const line = document.querySelector<HTMLElement>('[data-slot="header-line"]');
    expect(line?.textContent).toBe(SUMMARY.text);
    expect(line?.getAttribute('title')).toBe(SUMMARY.text);
    // Hidden in a narrow window (CSS breakpoint), left out of a compact bar.
    expect(line?.className).toContain('lg:flex');
  });

  it('no line without activity or summary', () => {
    renderHeader(sampleSummary());
    expect(document.querySelector('[data-slot="header-line"]')).toBeNull();
  });
});

describe('limit bar tooltip (WP-65 §1.4)', () => {
  it('used share and the reset as relative time', async () => {
    const profile = sampleProfileSummary();
    const resetsAt = new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString();
    clientStore.setState({
      hosts: {
        local: {
          ...emptyHostRecord('local'),
          hostState: sampleHostState({
            profiles: [profile],
            accountLimits: {
              [profile.id]: sampleRateLimitInfo({
                windows: { five_hour: { utilization: 0.08, resetsAt } },
                rateLimitType: null,
                utilization: null,
                resetsAt: null,
              }),
            },
          }),
        },
      },
    });
    render(
      <TooltipProvider>
        <AccountLimits />
      </TooltipProvider>,
    );
    const bar = document.querySelector<HTMLElement>('[data-limit="five_hour"]');
    if (bar === null) throw new Error('no limit bar');
    await userEvent.setup().hover(bar);
    expect((await screen.findByRole('tooltip')).textContent).toBe('8% used · resets in 2 hours');
  });
});
