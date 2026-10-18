import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleId } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_ENTRIES, NAVIGATION_WORK_PROFILE } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import type { ScenarioId } from '@web/playground/scenarios';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { requestShell } from '../requests';
import { installShortcutListener } from '../shortcuts';
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
  window.history.replaceState(null, '', '/');
});

async function start(scenario: ScenarioId = 'navigation'): Promise<RunningScenario> {
  running = startScenario(scenario);
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  await screen.findByRole('heading', { level: 1 });
  return running;
}

async function openHeaderMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Session actions' }));
  return screen.findByRole('menu');
}

describe('header (WP-35 §8)', () => {
  it('the "…" menu sits next to the status line and lists the session actions', async () => {
    await start();
    const user = userEvent.setup();
    const header = document.querySelector<HTMLElement>('[data-slot="session-header"]');
    // ADR-042: the status line itself stays without buttons.
    expect(header === null ? -1 : within(header).queryAllByRole('button')).toHaveLength(0);
    const menu = await openHeaderMenu(user);
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Earlier conversations…',
      'Session info…',
      'RenameF2',
      'Open in new window',
      'Open in external console',
      'Copy console command',
      'Put to sleep',
      'Archive',
    ]);
  });

  it('double click on the title edits it inline', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.dblClick(screen.getByRole('heading', { level: 1, name: 'Refactoring Auth-Service' }));
    const field = await screen.findByRole('textbox', { name: 'Session title' });
    await user.clear(field);
    await user.type(field, 'Auth{Enter}');
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.rename',
        entryId: NAVIGATION_ENTRIES.auth,
        title: 'Auth',
      });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Auth' })).toBeTruthy();
  });

  it('earlier conversations: all but the current, newest first; "Open" switches', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Earlier conversations…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Earlier conversations' });
    const list = within(dialog).getByRole('list', { name: 'Earlier conversations' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.dataset.conversation)).toEqual([
      sampleId('cv', 211),
      sampleId('cv', 212),
    ]);
    expect(within(items[0] ?? list).getByText(/Cleared \(\/clear\)/)).toBeTruthy();
    // Never started (no Claude session id): cannot be opened.
    const second = within(items[1] ?? list);
    expect(second.getByText('Untitled conversation')).toBeTruthy();
    expect(second.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(items[0] ?? list).getByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Earlier conversations' })).toBeNull();
    });
    expect(scenario.host.commands).toContainEqual({
      name: 'session.switchConversation',
      entryId: NAVIGATION_ENTRIES.auth,
      conversationId: sampleId('cv', 211),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up the OAuth client' })).toBeTruthy();
  });

  it('a busy session refuses the switch: SESSION_BUSY inside the dialog (ADR-126), the dialog stays', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    act(() => {
      scenario.host.patchSummary(NAVIGATION_ENTRIES.auth, {}, { runState: 'working' });
    });
    act(() => {
      requestShell({ kind: 'conversations', sessionKey: `local:${NAVIGATION_ENTRIES.auth}` });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Earlier conversations' });
    await user.click(within(dialog).getAllByRole('button', { name: 'Open' })[0] ?? dialog);
    // R4W-05: announced inside the dialog, not behind its overlay.
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The session is busy. Try again in a moment.');
    expect(alert.closest('[data-slot="conversations-error"]')).toBe(alert);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(within(region).queryByText('The session is busy. Try again in a moment.')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Earlier conversations' })).toBeTruthy();
    // The next try clears the old message; once the session is idle it switches and closes.
    act(() => {
      scenario.host.patchSummary(NAVIGATION_ENTRIES.auth, {}, { runState: 'idle' });
    });
    await user.click(within(dialog).getAllByRole('button', { name: 'Open' })[0] ?? dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Earlier conversations' })).toBeNull();
    });
  });

  it('session info shows model, mode, folder, branch, CLI, sign-in, session id, profile and MCP servers', async () => {
    await start();
    const user = userEvent.setup();
    const menu = await openHeaderMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Session info…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Session info' });
    const info = within(dialog);
    for (const text of [
      'claude-opus-5-5',
      'Accept edits',
      'D:\\work\\auth-service',
      'feature/login',
      '2.1.300',
      // R4W-14: known enum values translated ('none' = subscription, MCP status).
      'Subscription (claude.ai)',
      'Work',
      'github',
      'Connected',
      'playwright',
      'Failed',
    ]) {
      expect(info.getByText(text)).toBeTruthy();
    }
    act(() => {
      setLanguage('de');
    });
    expect(info.getByText('Abo (claude.ai)')).toBeTruthy();
    expect(info.getByText('Verbunden')).toBeTruthy();
    expect(info.getByText('Arbeitsverzeichnis')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Session-Info' })).toBeNull();
    });
  });
});

describe('pane banners (WP-35 §9)', () => {
  it('external console: since HH:MM, the hint, "Take back" with EXTERNAL_STILL_RUNNING as a warning', async () => {
    const scenario = await start('navigation-external');
    const user = userEvent.setup();
    const banner = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="pane-external"]');
      if (element === null) throw new Error('banner missing');
      return element;
    });
    expect(banner.textContent).toMatch(/Opened in an external console \(since .+\)/);
    expect(banner.textContent).toContain('Quit claude there');
    await user.click(within(banner).getByRole('button', { name: 'Take back' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    const notice = await within(region).findByText(/still open in an external console/);
    expect(notice.closest('[data-notice]')?.getAttribute('data-tone')).toBe('warning');
    // The fake console ended meanwhile: the banner says so, the second try takes it back.
    await waitFor(() => {
      expect(banner.dataset.running).toBe('false');
    });
    await user.click(within(banner).getByRole('button', { name: 'Take back' }));
    await waitFor(() => {
      expect(document.querySelector('[data-slot="pane-external"]')).toBeNull();
    });
    expect(scenario.host.commands.filter((cmd) => cmd.name === 'session.reclaim')).toHaveLength(2);
  });

  it('archived: banner with "Restore"; the composer slot stays', async () => {
    const scenario = await start('navigation-archived');
    const user = userEvent.setup();
    const banner = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="pane-archived"]');
      if (element === null) throw new Error('banner missing');
      return element;
    });
    expect(within(banner).getByText('Archived')).toBeTruthy();
    expect(screen.getByText('Composer not connected.')).toBeTruthy();
    await user.click(within(banner).getByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      expect(document.querySelector('[data-slot="pane-archived"]')).toBeNull();
    });
    expect(scenario.host.commands).toContainEqual({
      name: 'session.setArchived',
      entryId: NAVIGATION_ENTRIES.prototype,
      archived: false,
    });
  });
});

describe('subscription limits (WP-35 §10)', () => {
  it('per profile with limits: 5-hour and weekly bars, reset time, names with several profiles', async () => {
    const scenario = await start();
    const limits = screen.getByRole('region', { name: 'Subscription limits' });
    const standard = within(limits).getByRole('group', { name: 'Profile Standard' });
    const meters = within(standard).getAllByRole('meter');
    expect(
      meters.map((meter) => [meter.getAttribute('aria-label'), meter.getAttribute('aria-valuenow')]),
    ).toEqual([
      ['5-hour limit', '42'],
      ['Weekly limit', '78'],
    ]);
    expect(within(standard).getByText(/^Resets at /)).toBeTruthy();
    expect(within(standard).getByText(/^Resets on /)).toBeTruthy();
    const work = within(limits).getByRole('group', { name: 'Profile Work' });
    // No windows: the event's own window (rateLimitType + utilization).
    expect(within(work).getByRole('meter', { name: '5-hour limit' }).dataset.level).toBe('danger');

    // Only one profile left with limits: no names any more.
    act(() => {
      const state = scenario.host.hostState;
      const { [NAVIGATION_WORK_PROFILE]: _removed, ...rest } = state.accountLimits;
      scenario.host.setHostState({ ...state, accountLimits: rest });
    });
    await waitFor(() => {
      expect(within(limits).queryByRole('group')).toBeNull();
    });
    expect(within(limits).getAllByRole('meter')).toHaveLength(2);

    // Nothing reported: no section at all.
    act(() => {
      scenario.host.setHostState({ ...scenario.host.hostState, accountLimits: {} });
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Subscription limits' })).toBeNull();
    });
  });
});
