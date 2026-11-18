import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { windowsPathKey } from '@shared/paths';
import { setLanguage } from '@web/i18n';
import { STORAGE_KEYS, readStorage } from '@web/lib/storage';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { getSelectedSession } from '@web/state/selection';
import { clientStore, resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import {
  DEMO_HOST_KEYS,
  DEMO_HOSTS,
  DEMO_SHARED_FOLDER,
  startHostsDemo,
  type RunningHostsDemo,
} from '../hosts/hosts-demo';
import { closeNewSession } from '../NewSessionDialog';
import { installShortcutListener } from '../shortcuts';
import { resetRename } from './rename';
import { getCollapsedGroups, resetSidebarView, setGroupCollapsed, setSidebarGrouping } from './sidebar-view';

/**
 * WP-80 (WP-75 §4.4, ADR-226): the sidebar with other computers – badges, "Group by" computer
 * and/or folder, collapsible groups with counts, keyboard, grey rows of an unavailable computer –
 * and without them exactly the sidebar of WP-35 (README screenshots never show the feature).
 */

vi.setConfig({ testTimeout: 60_000 });

const COLORS = makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.colors);

let demo: RunningHostsDemo | null = null;
let single: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => {
    closeNewSession();
    resetRename();
  });
  demo?.stop();
  demo = null;
  single?.stop();
  single = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.localStorage.clear();
  window.sessionStorage.clear();
  act(() => {
    resetSidebarView();
    setLanguage('en');
  });
  window.history.replaceState(null, '', '/');
});

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sessions' });
}

function row(sessionKey: string): HTMLElement {
  const element = nav().querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]`);
  if (element === null) throw new Error(`row ${sessionKey} missing`);
  return element;
}

function rowKeys(): string[] {
  return [...nav().querySelectorAll<HTMLElement>('[data-session-row]')].map(
    (element) => element.dataset.sessionRow ?? '',
  );
}

/** A folder group by its key (keys hold backslashes: no CSS selector). */
function folderGroup(root: HTMLElement, key: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('[data-group]')].find(
    (element) => element.dataset.group === key,
  );
}

function toggle(key: string): HTMLButtonElement {
  const element = nav().querySelector<HTMLButtonElement>(`[data-group-toggle="${key}"]`);
  if (element === null) throw new Error(`header ${key} missing`);
  return element;
}

async function startWithHosts(): Promise<RunningHostsDemo> {
  demo = startHostsDemo();
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  await within(await screen.findByRole('navigation', { name: 'Sessions' })).findByText('Build pipeline');
  await within(nav()).findByText('Lab notes');
  return demo;
}

describe('without other computers (WP-35 sidebar unchanged)', () => {
  it('shows neither a badge nor the option "Computer", keeps the toggle and hides the header icon', async () => {
    single = startScenario('navigation');
    render(<AppShell />);
    await within(await screen.findByRole('navigation', { name: 'Sessions' })).findByText('Landing page copy');
    expect(document.querySelectorAll('[data-slot="host-badge"]')).toHaveLength(0);
    expect(document.querySelector('[data-slot="multi-host-indicator"]')).toBeNull();
    // The toggle of WP-35, not a menu: there is nothing to choose but the folder.
    const control = screen.getByRole('button', { name: 'Group by project' });
    expect(control.dataset.slot).toBe('sidebar-mode');
    expect(screen.queryByRole('button', { name: 'Group by' })).toBeNull();
    // A stored "by computer" has no effect without computers.
    act(() => {
      setSidebarGrouping({ byHost: true });
    });
    expect(nav().dataset.view).toBe('flat');
    expect(document.querySelectorAll('[data-host-group]')).toHaveLength(0);
  });
});

describe('with other computers', () => {
  it('badges the sessions of other computers (short name, color) and offers "Group by" Computer/Folder', async () => {
    await startWithHosts();
    const badge = row(DEMO_HOST_KEYS.pipeline).querySelector<HTMLElement>('[data-slot="host-badge"]');
    expect(badge?.textContent).toContain('Computer B');
    expect(badge?.dataset.hostColor).toBe('teal');
    expect(row(NAVIGATION_SESSION_KEYS.auth).querySelector('[data-slot="host-badge"]')).toBeNull();
    // The draft hint of WP-77 (summary.hasDraft).
    expect(row(DEMO_HOST_KEYS.landing).querySelector('[data-slot="row-draft"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Waiting for you (3)' })).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Group by' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Computer' }).getAttribute('aria-checked'),
    ).toBe('false');
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Computer' }));
    await waitFor(() => {
      expect(nav().dataset.view).toBe('host');
    });
    expect(readStorage('local', STORAGE_KEYS.sidebarMode)).toBe('host');
    // Fixed order: this computer first, then the list; each header with count and waiting.
    const groups = [...nav().querySelectorAll<HTMLElement>('[data-host-group]')];
    expect(groups.map((group) => group.dataset.hostGroup)).toEqual([
      LOCAL_HOST_ID,
      DEMO_HOSTS.b,
      DEMO_HOSTS.c,
    ]);
    const b = toggle(`host:${DEMO_HOSTS.b}`);
    expect(b.textContent).toContain('Computer B');
    expect(b.textContent).toContain('2 sessions');
    expect(b.textContent).toContain('1 waiting');
    expect(toggle(`host:${LOCAL_HOST_ID}`).textContent).toContain('This computer');
    // Grouped by computer the rows leave the badge out (the header names the computer).
    expect(row(DEMO_HOST_KEYS.pipeline).querySelector('[data-slot="host-badge"]')).toBeNull();
  });

  it("by folder: the same path on two computers is two groups, the other computer's with its badge", async () => {
    await startWithHosts();
    act(() => {
      setSidebarGrouping({ byFolder: true });
    });
    expect(nav().dataset.view).toBe('grouped');
    const local = folderGroup(nav(), `${LOCAL_HOST_ID}|${windowsPathKey(DEMO_SHARED_FOLDER)}`);
    const remote = folderGroup(nav(), `${DEMO_HOSTS.b}|${windowsPathKey(DEMO_SHARED_FOLDER)}`);
    expect(local).toBeDefined();
    expect(remote?.querySelector('[data-slot="host-badge"]')?.textContent).toContain('Computer B');
    expect(local?.querySelector('[data-group-toggle] [data-slot="host-badge"]')).toBeNull();
  });

  it('both: folders inside the computer; "New session here" of a folder passes the computer', async () => {
    await startWithHosts();
    act(() => {
      setSidebarGrouping({ byHost: true, byFolder: true });
    });
    expect(nav().dataset.view).toBe('host-folder');
    const b = nav().querySelector<HTMLElement>(`[data-host-group="${DEMO_HOSTS.b}"]`);
    expect(b?.querySelectorAll('[data-group]')).toHaveLength(2);
    const user = userEvent.setup();
    const folder =
      b === null ? undefined : folderGroup(b, `${DEMO_HOSTS.b}|${windowsPathKey(DEMO_SHARED_FOLDER)}`);
    if (folder === undefined) throw new Error('folder group missing');
    await user.click(within(folder).getByRole('button', { name: 'New session in this project…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('[data-slot="host-select"]')?.getAttribute('data-host-id')).toBe(
      DEMO_HOSTS.b,
    );
    expect(dialog.querySelector<HTMLInputElement>('input[name="cwd"]')?.value).toBe(DEMO_SHARED_FOLDER);
  });

  it('collapses groups: rows leave, Alt+1…9 counts visible rows only, the state is kept per window', async () => {
    await startWithHosts();
    act(() => {
      setSidebarGrouping({ byHost: true });
    });
    const user = userEvent.setup();
    const local = toggle(`host:${LOCAL_HOST_ID}`);
    expect(local.getAttribute('aria-expanded')).toBe('true');
    await user.click(local);
    expect(toggle(`host:${LOCAL_HOST_ID}`).getAttribute('aria-expanded')).toBe('false');
    expect(rowKeys()).toEqual([DEMO_HOST_KEYS.pipeline, DEMO_HOST_KEYS.landing, DEMO_HOST_KEYS.lab]);
    expect(readStorage('session', STORAGE_KEYS.sidebarCollapsedGroups)).toBe(
      JSON.stringify([`host:${LOCAL_HOST_ID}`]),
    );
    expect(readStorage('local', STORAGE_KEYS.sidebarCollapsedGroups)).toBe(
      JSON.stringify([`host:${LOCAL_HOST_ID}`]),
    );
    // The selected session (local) is inside the collapsed group: its header is marked.
    expect(toggle(`host:${LOCAL_HOST_ID}`).querySelector('[data-slot="group-selected"]')).not.toBeNull();
    await user.keyboard('{Alt>}2{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(DEMO_HOST_KEYS.landing);
    });
  });

  it('Alt+N and "Waiting for you" count every session and expand the target\'s group', async () => {
    await startWithHosts();
    act(() => {
      setSidebarGrouping({ byHost: true });
      setGroupCollapsed(`host:${DEMO_HOSTS.b}`, true);
    });
    expect(nav().querySelector(`[data-session-row="${DEMO_HOST_KEYS.pipeline}"]`)).toBeNull();
    act(() => {
      clientStore.setState({ selectedSession: COLORS });
    });
    const user = userEvent.setup();
    // Order by computer: local colors → local migration → B pipeline.
    await user.keyboard('{Alt>}n{/Alt}');
    await user.keyboard('{Alt>}n{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(DEMO_HOST_KEYS.pipeline);
    });
    expect(getCollapsedGroups().has(`host:${DEMO_HOSTS.b}`)).toBe(false);
    expect(row(DEMO_HOST_KEYS.pipeline).getAttribute('aria-current')).toBe('true');
  });

  it('tree keys: arrows reach the headers, Left collapses or goes to the parent, Right expands', async () => {
    await startWithHosts();
    act(() => {
      setSidebarGrouping({ byHost: true, byFolder: true });
    });
    const user = userEvent.setup();
    const pipeline = row(DEMO_HOST_KEYS.pipeline);
    pipeline.focus();
    // Left from a row: its folder header; Left again: collapse it; once more: the computer header.
    await user.keyboard('{ArrowLeft}');
    const folderHeader = document.activeElement;
    expect(folderHeader?.getAttribute('data-group-toggle')).toMatch(/^folder:computer-b\|/);
    await user.keyboard('{ArrowLeft}');
    expect(folderHeader?.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(toggle(`host:${DEMO_HOSTS.b}`));
    await user.keyboard('{ArrowLeft}');
    expect(toggle(`host:${DEMO_HOSTS.b}`).getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowRight}');
    expect(toggle(`host:${DEMO_HOSTS.b}`).getAttribute('aria-expanded')).toBe('true');
    // Right on an expanded header goes to its first entry (the collapsed folder header).
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('data-group-toggle')).toMatch(/^folder:computer-b\|/);
    // Down from the last row of a group reaches the next header.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-group-toggle')).toMatch(/^folder:computer-b\|/);
  });

  it('an unreachable computer: grey rows with its status, the header names it; back when reachable', async () => {
    const running = await startWithHosts();
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.b, false);
    });
    await waitFor(() => {
      expect(row(DEMO_HOST_KEYS.pipeline).dataset.hostUnavailable).toBe('unreachable');
    });
    expect(row(DEMO_HOST_KEYS.pipeline).textContent).toContain('Computer Computer B: Not reachable');
    act(() => {
      setSidebarGrouping({ byHost: true });
    });
    expect(toggle(`host:${DEMO_HOSTS.b}`).textContent).toContain('Not reachable');
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.b, true);
    });
    await waitFor(() => {
      expect(row(DEMO_HOST_KEYS.pipeline).dataset.hostUnavailable).toBeUndefined();
    });
  });

  it('drops collapsed groups that no longer exist once every list is loaded', async () => {
    window.sessionStorage.setItem(
      STORAGE_KEYS.sidebarCollapsedGroups,
      JSON.stringify([`host:${DEMO_HOSTS.c}`, 'host:computer-gone', 'folder:local|x:\\gone']),
    );
    act(() => {
      resetSidebarView();
    });
    await startWithHosts();
    await waitFor(() => {
      expect([...getCollapsedGroups()]).toEqual([`host:${DEMO_HOSTS.c}`]);
    });
  });

  it('a removed computer leaves the sidebar at once', async () => {
    const running = await startWithHosts();
    act(() => {
      running.scenario.host.setHostState({
        ...running.scenario.host.hostState,
        remoteHosts: running.scenario.host.hostState.remoteHosts.filter(
          (host) => host.hostId !== DEMO_HOSTS.c,
        ),
      });
    });
    await waitFor(() => {
      expect(nav().querySelector(`[data-session-row="${DEMO_HOST_KEYS.lab}"]`)).toBeNull();
    });
  });
});

describe('stored grouping', () => {
  it('reads the WP-35 value "grouped" as "by folder"', () => {
    window.localStorage.setItem(STORAGE_KEYS.sidebarMode, 'grouped');
    act(() => {
      resetSidebarView();
    });
    single = startScenario('navigation');
    render(<AppShell />);
    expect(nav().dataset.view).toBe('grouped');
  });
});
