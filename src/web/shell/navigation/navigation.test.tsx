import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { setLanguage } from '@web/i18n';
import { STORAGE_KEYS, readStorage } from '@web/lib/storage';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import type { ScenarioId } from '@web/playground/scenarios';
import { getSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { closeNewSession } from '../NewSessionDialog';
import { registerShellRequestHandler, requestShell } from '../requests';
import { installShortcutListener } from '../shortcuts';
import { resetRename } from './rename';
import { newSessionIn } from './session-actions';
import { resetSidebarView, setSidebarMode } from './sidebar-view';

// The whole shell renders per test: ~1 s alone, much longer when several runs load the machine
// (docs/wp/FLAKES.md).
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

afterEach(() => {
  act(() => {
    closeNewSession();
    resetRename();
    resetSidebarView();
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.localStorage.removeItem(STORAGE_KEYS.sidebarMode);
  act(() => {
    setSidebarMode('flat');
    setLanguage('en');
  });
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

async function start(scenario: ScenarioId = 'navigation'): Promise<RunningScenario> {
  running = startScenario(scenario);
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  const nav = await screen.findByRole('navigation', { name: 'Sessions' });
  await within(nav).findByText('Landing page copy');
  return running;
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

const FLAT_ORDER = [
  KEYS.landing,
  KEYS.colors,
  KEYS.migration,
  KEYS.redirect,
  KEYS.auth,
  KEYS.external,
  KEYS.release,
];

describe('sidebar entries (WP-35 §1)', () => {
  it('shows two lines: path, branch only when set, short model name, context level 70/85', async () => {
    await start();
    const landing = within(row(KEYS.landing));
    const path = row(KEYS.landing).querySelector('[data-slot="row-path"]');
    expect(path?.textContent).toBe('web\\landing');
    // WP41-02: the project folder sits in an element of its own that never shrinks.
    expect(path?.querySelector('[data-slot="path-head"]')?.textContent).toBe('web');
    const last = path?.querySelector('[data-slot="path-last"]');
    expect(last?.textContent).toBe('\\landing');
    expect(last?.className.split(' ')).toContain('shrink-0');
    expect(row(KEYS.landing).querySelector('[data-slot="row-branch"]')?.textContent).toBe('Branchmain');
    expect(row(KEYS.landing).querySelector('[data-slot="row-model"]')?.textContent).toBe('Modelhaiku');
    expect(row(KEYS.landing).querySelector('[data-slot="row-context"]')?.getAttribute('data-level')).toBe(
      'danger',
    );
    expect(landing.getByText('Pinned')).toBeTruthy();
    expect(row(KEYS.auth).querySelector('[data-slot="row-context"]')?.getAttribute('data-level')).toBe(
      'warning',
    );
    expect(row(KEYS.redirect).querySelector('[data-slot="row-context"]')?.getAttribute('data-level')).toBe(
      'normal',
    );
    // Screen readers get the percentage as text next to "Context".
    expect(row(KEYS.auth).textContent).toContain('Context72%');
    // No branch, model from modelSetting (`fable`), custom model kept.
    expect(row(KEYS.release).querySelector('[data-slot="row-branch"]')).toBeNull();
    expect(row(KEYS.release).querySelector('[data-slot="row-model"]')?.textContent).toBe('Modelfable');
    expect(row(KEYS.migration).querySelector('[data-slot="row-model"]')?.textContent).toBe(
      'Modelinternal-coder-xl',
    );
    // Archived entries are not in the main list.
    expect(rowKeys()).not.toContain(KEYS.prototype);
  });

  it('flat: pinned first, then waiting → activity; Alt+1…9 picks the n-th visible entry', async () => {
    await start();
    const user = userEvent.setup();
    expect(rowKeys().slice(0, FLAT_ORDER.length)).toEqual(FLAT_ORDER);
    await user.keyboard('{Alt>}3{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.migration);
    });
    await user.keyboard('{Alt>}1{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.landing);
    });
  });

  it('grouped: groups by folder (attention first), Alt+1…9 follows the grouped order, the mode is kept', async () => {
    await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Group by project' }));
    await waitFor(() => {
      expect(nav().dataset.view).toBe('grouped');
    });
    expect(readStorage('local', STORAGE_KEYS.sidebarMode)).toBe('grouped');
    const groups = within(nav()).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('data-group'))).toEqual([
      'local|d:\\work\\web\\landing',
      'local|d:\\work\\db\\migrations',
      'local|d:\\work\\auth-service',
      'local|d:\\work\\infra',
      'local|d:\\work\\scraper',
    ]);
    expect(rowKeys().slice(0, 4)).toEqual([KEYS.landing, KEYS.colors, KEYS.release, KEYS.migration]);
    // The group header names the folder; the rows leave the path out.
    expect(row(KEYS.landing).querySelector('[data-slot="row-path"]')).toBeNull();
    await user.keyboard('{Alt>}3{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.release);
    });
  });

  it('"New session in this project…" of a group asks the shell for a pre-filled dialog', async () => {
    await start();
    const user = userEvent.setup();
    const handler = vi.fn(() => true);
    cleanups.push(registerShellRequestHandler('newSession', handler));
    act(() => {
      setSidebarMode('grouped');
    });
    const group = await within(nav()).findByRole('group', { name: 'Project D:\\work\\db\\migrations' });
    await user.click(within(group).getByRole('button', { name: 'New session in this project…' }));
    expect(handler).toHaveBeenCalledWith({ kind: 'newSession', cwd: 'D:\\work\\db\\migrations' });
  });

  it('"New session in this project…" without a mounted dialog keeps the folder for its opening (WP-40)', async () => {
    running = startScenario('navigation');
    // Nobody handles `newSession` yet: the fallback opens the dialog as soon as it mounts …
    act(() => {
      newSessionIn('D:\\work\\db\\migrations');
    });
    render(<AppShell />);
    const dialog = await screen.findByRole('dialog');
    // … pre-filled with the folder (before WP-40 the fallback dropped it).
    expect(dialog.querySelector<HTMLInputElement>('input[name="cwd"]')?.value).toBe(
      'D:\\work\\db\\migrations',
    );
  });

  it('Alt+N and "Waiting for you (n)" go to the next waiting session after the selection, cyclically', async () => {
    await start();
    const user = userEvent.setup();
    expect(getSelectedSession()).toBe(KEYS.auth);
    await user.keyboard('{Alt>}n{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.colors);
    });
    await user.click(screen.getByRole('button', { name: 'Waiting for you (2)' }));
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.migration);
    });
    await user.keyboard('{Alt>}n{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.colors);
    });
  });

  it('archive view: archived sessions with "Restore"', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Archive (2)' }));
    await waitFor(() => {
      expect(nav().dataset.view).toBe('archive');
    });
    expect(rowKeys()).toEqual([KEYS.prototype, makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.spike)]);
    const restore = within(row(KEYS.prototype).closest('li') ?? nav()).getByRole('button', {
      name: 'Restore',
    });
    await user.click(restore);
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.setArchived',
        entryId: NAVIGATION_ENTRIES.prototype,
        archived: false,
      });
    });
    await waitFor(() => {
      expect(rowKeys()).toEqual([makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.spike)]);
    });
    await user.click(within(nav()).getByRole('button', { name: 'Back to the sessions' }));
    expect(rowKeys()).toContain(KEYS.prototype);
  });
});

async function openContextMenu(sessionKey: string): Promise<HTMLElement> {
  fireEvent.contextMenu(row(sessionKey));
  return screen.findByRole('menu');
}

describe('context menu (WP-35 §3)', () => {
  it('sends pin, sleep, archive and external console as commands', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    let menu = await openContextMenu(KEYS.redirect);
    // The working session: no "Put to sleep" while a turn runs.
    expect(within(menu).getByRole('menuitem', { name: 'Put to sleep' }).hasAttribute('data-disabled')).toBe(
      true,
    );
    await user.click(within(menu).getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.setPinned',
        entryId: NAVIGATION_ENTRIES.redirect,
        pinned: true,
      });
    });
    // Pinned → it moves up into the pinned part (working before idle there too).
    await waitFor(() => {
      expect(rowKeys().slice(0, 2)).toEqual([KEYS.redirect, KEYS.landing]);
    });

    menu = await openContextMenu(KEYS.auth);
    await user.click(within(menu).getByRole('menuitem', { name: 'Put to sleep' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.close',
        entryId: NAVIGATION_ENTRIES.auth,
      });
    });

    menu = await openContextMenu(KEYS.auth);
    await user.click(within(menu).getByRole('menuitem', { name: 'Open in external console' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.openExternal',
        entryId: NAVIGATION_ENTRIES.auth,
      });
    });

    menu = await openContextMenu(KEYS.landing);
    await user.click(within(menu).getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.setArchived',
        entryId: NAVIGATION_ENTRIES.landing,
        archived: true,
      });
    });
    await waitFor(() => {
      expect(rowKeys()).not.toContain(KEYS.landing);
    });
  });

  it('a refusal comes back as a notice (SESSION_BUSY)', async () => {
    await start();
    const user = userEvent.setup();
    const menu = await openContextMenu(KEYS.redirect);
    await user.click(within(menu).getByRole('menuitem', { name: 'Open in external console' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(region).findByText('The session is busy. Try again in a moment.')).toBeTruthy();
  });

  it('opens a new window without opener and copies the console command with the warning', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let menu = await openContextMenu(KEYS.auth);
    await user.click(within(menu).getByRole('menuitem', { name: 'Open in new window' }));
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/#session=${NAVIGATION_ENTRIES.auth}`,
      '_blank',
      'popup,noopener',
    );

    menu = await openContextMenu(KEYS.auth);
    await user.click(within(menu).getByRole('menuitem', { name: 'Copy console command' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(region).findByText(/two writers/)).toBeTruthy();
    expect(scenario.host.commands).toContainEqual({
      name: 'session.consoleCommand',
      entryId: NAVIGATION_ENTRIES.auth,
    });
    await expect(navigator.clipboard.readText()).resolves.toContain('--resume');
  });

  it('the "…" button appears on hover and focus and offers the same actions', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const item = row(KEYS.release).closest('li');
    if (item === null) throw new Error('row item missing');
    expect(within(item).queryByRole('button', { name: /Actions for/ })).toBeNull();
    await user.hover(item);
    const actions = await within(item).findByRole('button', { name: 'Actions for “Release notes 2.4”' });
    await user.unhover(item);
    // Keyboard: the row has the focus, Tab reaches "…".
    act(() => {
      row(KEYS.release).focus();
    });
    expect(within(item).getByRole('button', { name: 'Actions for “Release notes 2.4”' })).toBeTruthy();
    await user.click(
      actions.isConnected ? actions : within(item).getByRole('button', { name: /Actions for/ }),
    );
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.setPinned',
        entryId: NAVIGATION_ENTRIES.release,
        pinned: true,
      });
    });
  });
});

describe('inline rename (WP-35 §4)', () => {
  it('double click on the title: Enter saves, unchanged sends nothing, Esc cancels', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.dblClick(within(row(KEYS.release)).getByText('Release notes 2.4'));
    let field = await screen.findByRole('textbox', { name: 'Session title' });
    expect(document.activeElement).toBe(field);
    await user.clear(field);
    await user.type(field, 'Release notes 2.5{Enter}');
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.rename',
        entryId: NAVIGATION_ENTRIES.release,
        title: 'Release notes 2.5',
      });
    });
    expect(screen.queryByRole('textbox', { name: 'Session title' })).toBeNull();
    // Enter/Esc give the focus back to the row.
    await waitFor(() => {
      expect(document.activeElement).toBe(row(KEYS.release));
    });

    const before = scenario.host.commands.length;
    await user.dblClick(await within(row(KEYS.release)).findByText('Release notes 2.5'));
    field = await screen.findByRole('textbox', { name: 'Session title' });
    await user.type(field, ' and more{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Session title' })).toBeNull();
    await user.dblClick(within(row(KEYS.release)).getByText('Release notes 2.5'));
    await user.keyboard('{Enter}');
    expect(scenario.host.commands.slice(before).filter((cmd) => cmd.name === 'session.rename')).toEqual([]);
  });

  it('an empty title goes back to the automatic title (null)', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    act(() => {
      scenario.host.patchSummary(NAVIGATION_ENTRIES.release, { titleSource: 'custom' });
    });
    await user.dblClick(within(row(KEYS.release)).getByText('Release notes 2.4'));
    const field = await screen.findByRole('textbox', { name: 'Session title' });
    await user.clear(field);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.rename',
        entryId: NAVIGATION_ENTRIES.release,
        title: null,
      });
    });
  });

  it('F2 edits the focused row, otherwise the selected session in the header; renameTitle does the same', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    act(() => {
      row(KEYS.redirect).focus();
    });
    await user.keyboard('{F2}');
    const inRow = await within(nav()).findByRole('textbox', { name: 'Session title' });
    expect((inRow as HTMLInputElement).value).toBe('Fix the login redirect');
    await user.keyboard('{Escape}');

    // Focus outside the sidebar: the header of the selected session.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await user.keyboard('{F2}');
    const header = document.querySelector<HTMLElement>('[data-slot="session-header"]');
    if (header === null) throw new Error('header missing');
    const inHeader = await within(header).findByRole('textbox', { name: 'Session title' });
    await user.clear(inHeader);
    await user.type(inHeader, 'Auth refactoring{Enter}');
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.rename',
        entryId: NAVIGATION_ENTRIES.auth,
        title: 'Auth refactoring',
      });
    });

    // `/rename` without an argument (WP-37) asks through the request channel.
    let handled = false;
    act(() => {
      handled = requestShell({ kind: 'renameTitle', sessionKey: KEYS.auth });
    });
    expect(handled).toBe(true);
    expect(await within(header).findByRole('textbox', { name: 'Session title' })).toBeTruthy();
    expect(
      requestShell({ kind: 'renameTitle', sessionKey: 'local:en_ffffffffffffffffffffffffffffffff' }),
    ).toBe(false);
  });

  it('"Rename" from the context menu opens the field with the focus in it', async () => {
    await start();
    const user = userEvent.setup();
    const menu = await openContextMenu(KEYS.colors);
    await user.click(within(menu).getByRole('menuitem', { name: /Rename/ }));
    const field = await within(nav()).findByRole('textbox', { name: 'Session title' });
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
  });
});

describe('quick switcher (WP-35 §5)', () => {
  it('Ctrl+K: waiting first, fuzzy over title/path/branch/profile, Enter selects', async () => {
    await start();
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Switch session' });
    const options = () =>
      within(dialog)
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(options()[0]).toContain('Answer the color question');
    expect(options()[1]).toContain('Database migration plan');
    expect(options()).toHaveLength(8);
    // WP41-02: the project folder in an element of its own that never shrinks.
    const firstPath = within(dialog).getAllByRole('option')[0]?.querySelector('[data-slot="switcher-path"]');
    expect(firstPath?.textContent).toBe('web\\landing');
    expect(firstPath?.querySelector('[data-slot="path-last"]')?.className.split(' ')).toContain('shrink-0');
    const input = within(dialog).getByRole('combobox', { name: 'Switch session' });
    // Branch and profile are searchable too.
    await user.type(input, 'redirect-loop');
    expect(options()).toHaveLength(1);
    await user.clear(input);
    await user.type(input, 'work');
    expect(options().every((text) => text.includes('Work') || text.includes('work'))).toBe(true);
    await user.clear(input);
    await user.type(input, 'scraper');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull();
    });
    expect(getSelectedSession()).toBe(makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.scraper));
  });

  it('Shift+Enter opens the session in a new window (noopener); the request quickSwitcher opens it too', async () => {
    await start();
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    let handled = false;
    act(() => {
      handled = requestShell({ kind: 'quickSwitcher' });
    });
    expect(handled).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: 'Switch session' });
    await user.type(within(dialog).getByRole('combobox'), 'landing page');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/#session=${NAVIGATION_ENTRIES.landing}`,
      '_blank',
      'popup,noopener',
    );
    expect(getSelectedSession()).toBe(KEYS.auth);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull();
    });
  });
});
