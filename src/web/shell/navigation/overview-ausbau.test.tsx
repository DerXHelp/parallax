/**
 * WP-115 in the navigation (F6, WP-110 §3.7): the sidebar filter (status buttons, text, kept per
 * window, Alt+N past the filter), "Mark as (un)read", muting a project, a worktree session in its
 * repository with its branch, archive/remove of a worktree session through `worktree.cleanup`, and
 * "Search in contents: …" in the quick switcher.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { Command, CommandOf } from '@shared/protocol';
import { sampleWorktreeRef } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { readStorage, writeStorage } from '@web/lib/storage';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { getSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { registerShellRequestHandler, type ShellRequestOf } from '../requests';
import { installShortcutListener } from '../shortcuts';
import { resetRename } from './rename';
import {
  getSidebarFilter,
  resetSidebarView,
  setSidebarFilter,
  setSidebarMode,
  SIDEBAR_FILTER_KEYS,
} from './sidebar-view';
import { RailFilterIndicator, SidebarFilterBar, SidebarFilterEmpty } from './SidebarFilter';

vi.setConfig({ testTimeout: 60_000 });

const KEYS = {
  colors: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.colors),
  migration: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.migration),
  redirect: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.redirect),
  release: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.release),
  ...NAVIGATION_SESSION_KEYS,
};

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

function clearFilterStorage(): void {
  for (const key of Object.values(SIDEBAR_FILTER_KEYS)) {
    writeStorage('session', key, null);
    writeStorage('local', key, null);
  }
}

afterEach(() => {
  clearFilterStorage();
  act(() => {
    resetRename();
    resetSidebarView();
    setSidebarMode('flat');
    setLanguage('en');
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

/** The navigation scenario with the WP-110 features of this computer (`overview`, `search`). */
async function start(features: { overview?: boolean; search?: boolean } = {}): Promise<RunningScenario> {
  const scenario = startScenario('navigation');
  running = scenario;
  act(() => {
    scenario.host.setHostState({
      ...scenario.host.hostState,
      features: { git: false, search: features.search ?? true, overview: features.overview ?? true },
    });
  });
  cleanups.push(installShortcutListener());
  // The coordinator wires the filter into Sidebar/SidebarFrame (WP-117); here it renders beside it.
  render(
    <>
      <SidebarFilterBar />
      <SidebarFilterEmpty />
      <RailFilterIndicator />
      <AppShell />
    </>,
  );
  const nav = await screen.findByRole('navigation', { name: 'Sessions' });
  await within(nav).findByText('Landing page copy');
  return scenario;
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sessions' });
}

function row(sessionKey: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]`);
  if (element === null) throw new Error(`row ${sessionKey} missing`);
  return element;
}

function rowKeys(): string[] {
  return [...nav().querySelectorAll<HTMLElement>('[data-session-row]')].map(
    (element) => element.dataset.sessionRow ?? '',
  );
}

function filterButton(status: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-slot="sidebar-filter"] [data-filter="${status}"]`,
  );
  if (element === null) throw new Error(`filter ${status} missing`);
  return element;
}

async function openContextMenu(sessionKey: string): Promise<HTMLElement> {
  fireEvent.contextMenu(row(sessionKey));
  return screen.findByRole('menu');
}

function commandsOf<N extends Command['name']>(scenario: RunningScenario, name: N): CommandOf<N>[] {
  return scenario.host.commands.filter((cmd): cmd is CommandOf<N> => cmd.name === name);
}

describe('sidebar filter (WP-115)', () => {
  it('status buttons with counters, text over title/folder/branch, Esc clears the text', async () => {
    await start();
    const user = userEvent.setup();
    expect(filterButton('unread').querySelector('[data-slot="filter-count"]')?.textContent).toBe('1');
    expect(filterButton('all').querySelector('[data-slot="filter-count"]')).toBeNull();

    await user.click(filterButton('unread'));
    await waitFor(() => {
      expect(rowKeys()).toEqual([KEYS.auth]);
    });
    // The rail of a collapsed sidebar names the active filter.
    expect(screen.getByRole('button', { name: 'Filter: Unread – show all sessions' })).toBeTruthy();

    await user.click(filterButton('all'));
    const field = screen.getByRole('textbox', { name: 'Filter by title, folder or branch' });
    await user.type(field, 'redirect-loop');
    await waitFor(() => {
      expect(rowKeys()).toEqual([KEYS.redirect]);
    });
    await user.clear(field);
    await user.type(field, 'web landing');
    await waitFor(() => {
      expect(rowKeys().sort()).toEqual([KEYS.colors, KEYS.landing, KEYS.release].sort());
    });
    await user.keyboard('{Escape}');
    expect(getSidebarFilter().text).toBe('');
    await waitFor(() => {
      expect(rowKeys().length).toBeGreaterThan(3);
    });
  });

  it('an empty result says so and resets; the filter is kept per window', async () => {
    await start();
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: 'Filter by title, folder or branch' }),
      'nothing-matches',
    );
    await waitFor(() => {
      expect(rowKeys()).toEqual([]);
    });
    expect(readStorage('session', SIDEBAR_FILTER_KEYS.text)).toBe('nothing-matches');
    expect(document.querySelector('[data-slot="sidebar-filter-empty"]')?.textContent).toContain(
      '“nothing-matches”',
    );
    await user.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(getSidebarFilter()).toEqual({ status: 'all', text: '' });
    expect(readStorage('session', SIDEBAR_FILTER_KEYS.text)).toBeNull();

    // A new window of the same profile starts with the stored status (session storage first).
    act(() => {
      setSidebarFilter({ status: 'working', text: 'api' });
    });
    act(() => {
      resetSidebarView();
    });
    expect(getSidebarFilter()).toEqual({ status: 'working', text: 'api' });
    writeStorage('session', SIDEBAR_FILTER_KEYS.status, null);
    writeStorage('session', SIDEBAR_FILTER_KEYS.text, null);
    act(() => {
      resetSidebarView();
    });
    expect(getSidebarFilter()).toEqual({ status: 'working', text: '' });
  });

  it('Alt+N reaches a waiting session the filter hides and resets the filter', async () => {
    await start();
    const user = userEvent.setup();
    await user.click(filterButton('unread'));
    await waitFor(() => {
      expect(rowKeys()).toEqual([KEYS.auth]);
    });
    await user.keyboard('{Alt>}n{/Alt}');
    await waitFor(() => {
      expect([KEYS.migration, KEYS.colors]).toContain(getSelectedSession());
    });
    expect(getSidebarFilter().status).toBe('all');
    await waitFor(() => {
      expect(rowKeys()).toContain(KEYS.landing);
    });
  });
});

describe('unread, mute, worktrees (WP-115)', () => {
  it('"Mark as unread" / "Mark as read" send session.setUnread; not without the overview feature', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    let menu = await openContextMenu(KEYS.landing);
    await user.click(within(menu).getByRole('menuitem', { name: 'Mark as unread' }));
    await waitFor(() => {
      expect(commandsOf(scenario, 'session.setUnread')).toEqual([
        { name: 'session.setUnread', entryId: NAVIGATION_ENTRIES.landing, unread: true },
      ]);
    });
    menu = await openContextMenu(KEYS.auth);
    await user.click(within(menu).getByRole('menuitem', { name: 'Mark as read' }));
    await waitFor(() => {
      expect(commandsOf(scenario, 'session.setUnread').at(-1)).toEqual({
        name: 'session.setUnread',
        entryId: NAVIGATION_ENTRIES.auth,
        unread: false,
      });
    });
    await user.keyboard('{Escape}');
    act(() => {
      scenario.host.setHostState({
        ...scenario.host.hostState,
        features: { git: false, search: false, overview: false },
      });
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="sidebar-filter"]')).not.toBeNull();
    });
    menu = await openContextMenu(KEYS.landing);
    expect(within(menu).queryByRole('menuitem', { name: 'Mark as unread' })).toBeNull();
  });

  it('mutes and unmutes a project (whole notification settings, exact path); bell-off on the header', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    act(() => {
      setSidebarMode('grouped');
    });
    const group = await within(nav()).findByRole('group', { name: 'Project D:\\work\\db\\migrations' });
    const header = group.querySelector<HTMLElement>('[data-group-toggle]');
    if (header === null) throw new Error('group header missing');
    fireEvent.contextMenu(header);
    let menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Mute notifications' }));
    await waitFor(() => {
      expect(commandsOf(scenario, 'settings.update')).toHaveLength(1);
    });
    const patch = commandsOf(scenario, 'settings.update')[0]?.patch;
    expect(patch?.notifications?.mutedProjects).toEqual(['D:\\work\\db\\migrations']);
    // The whole object goes along (a patch replaces `notifications`).
    expect(Object.keys(patch?.notifications ?? {}).length).toBeGreaterThan(1);
    await waitFor(() => {
      expect(group.querySelector('[data-slot="group-muted"]')).not.toBeNull();
    });
    expect(within(group).getByText('Notifications muted')).toBeTruthy();

    fireEvent.contextMenu(header);
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Unmute notifications' }));
    await waitFor(() => {
      expect(commandsOf(scenario, 'settings.update').at(-1)?.patch.notifications?.mutedProjects).toEqual([]);
    });
    await waitFor(() => {
      expect(group.querySelector('[data-slot="group-muted"]')).toBeNull();
    });
  });

  it('a worktree session sits in its repository group with its branch; archive/remove ask for the cleanup', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const worktree = sampleWorktreeRef({
      repoRoot: 'D:\\work\\db\\migrations',
      path: 'D:\\work\\db\\migrations\\.claude\\worktrees\\feature-login',
    });
    act(() => {
      scenario.host.patchSummary(NAVIGATION_ENTRIES.redirect, {
        cwd: worktree.path,
        worktree,
        gitBranch: null,
      });
      setSidebarMode('grouped');
    });
    const group = await within(nav()).findByRole('group', { name: 'Project D:\\work\\db\\migrations' });
    await waitFor(() => {
      expect(within(group).queryByText('Fix the login redirect')).not.toBeNull();
    });
    const branch = row(KEYS.redirect).querySelector<HTMLElement>('[data-slot="row-branch"]');
    expect(branch?.dataset.worktree).toBe('true');
    expect(branch?.textContent).toContain('feature/login');
    expect(branch?.textContent).toContain('Worktree branch');

    const cleanup: ShellRequestOf<'worktree.cleanup'>[] = [];
    const remove = registerShellRequestHandler('worktree.cleanup', (request) => {
      cleanup.push(request);
      return true;
    });
    let menu = await openContextMenu(KEYS.redirect);
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    menu = await openContextMenu(KEYS.redirect);
    await user.click(within(menu).getByRole('menuitem', { name: /Remove from Parallax/ }));
    await waitFor(() => {
      expect(cleanup).toEqual([
        { kind: 'worktree.cleanup', sessionKey: KEYS.redirect, then: 'archive' },
        { kind: 'worktree.cleanup', sessionKey: KEYS.redirect, then: 'remove' },
      ]);
    });
    expect(commandsOf(scenario, 'session.setArchived')).toEqual([]);

    // Nobody takes the request (no worktree feature wired): archived as before.
    remove();
    menu = await openContextMenu(KEYS.redirect);
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => {
      expect(commandsOf(scenario, 'session.setArchived')).toEqual([
        { name: 'session.setArchived', entryId: NAVIGATION_ENTRIES.redirect, archived: true },
      ]);
    });
  });
});

describe('quick switcher: "Search in contents" (WP-115)', () => {
  it('the last option opens the full-text search with the text', async () => {
    await start();
    const user = userEvent.setup();
    const opened: ShellRequestOf<'search.open'>[] = [];
    cleanups.push(
      registerShellRequestHandler('search.open', (request) => {
        opened.push(request);
        return true;
      }),
    );
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.keyboard('zzzz');
    const option = await within(dialog).findByRole('option', { name: /Search in contents: “zzzz”/ });
    expect(option.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(opened).toEqual([{ kind: 'search.open', text: 'zzzz' }]);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('no option without a computer that searches contents, or with one character', async () => {
    await start({ search: false });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.keyboard('login');
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0);
    });
    expect(within(dialog).queryByText(/Search in contents/)).toBeNull();
  });
});
