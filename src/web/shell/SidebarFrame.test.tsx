import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { STORAGE_KEYS } from '@web/lib/storage';
import { getSelectedSession, setSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { AppShell } from './AppShell';
import { resetRename } from './navigation/rename';
import { resetSidebarView } from './navigation/sidebar-view';
import { installShortcutListener } from './shortcuts';
import {
  isNarrowWindow,
  NARROW_WINDOW_BELOW,
  readSidebarCollapsed,
  readSidebarWidth,
  resetSidebarLayout,
  SIDEBAR_DEFAULT_WIDTH,
  sidebarMaxWidth,
} from './sidebar-layout';

vi.setConfig({ testTimeout: 60_000 });

/**
 * A storage whose reads and writes throw (privacy settings, quota), recording the attempts. Tests
 * hand it out through a spy on the `window.localStorage`/`sessionStorage` getter: in happy-dom a
 * spy on `Storage.prototype` misses methods that were used before, and a spy on the storage
 * instance (a Proxy) is not undone by `vi.restoreAllMocks()` (FIX-R5 F4/F5).
 */
function brokenStorage(attempts: string[]): Storage {
  return {
    length: 0,
    clear: () => undefined,
    key: () => null,
    getItem: (key) => {
      attempts.push(`get ${key}`);
      throw new Error('SecurityError');
    },
    setItem: (key) => {
      attempts.push(`set ${key}`);
      throw new Error('QuotaExceededError');
    },
    removeItem: (key) => {
      attempts.push(`remove ${key}`);
      throw new Error('SecurityError');
    },
  };
}

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
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetSidebarLayout();
  setWindowWidth(originalWidth);
  window.history.replaceState(null, '', '/');
});

async function start(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  await screen.findByRole('heading', { level: 1 });
  return running;
}

function frame(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="sidebar-frame"]');
  if (element === null) throw new Error('sidebar frame missing');
  return element;
}

function rail(): HTMLElement | null {
  return screen.queryByRole('navigation', { name: 'Sessions (collapsed sidebar)' });
}

function showButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Show sessions' });
}

describe('sidebar-layout', () => {
  it(`narrow below ${String(NARROW_WINDOW_BELOW)} px; an unknown width counts as wide`, () => {
    expect(isNarrowWindow(899)).toBe(true);
    expect(isNarrowWindow(900)).toBe(false);
    expect(isNarrowWindow(0)).toBe(false);
  });

  it('reads this window first, then the last choice of any window; broken storage = expanded', () => {
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, 'true');
    expect(readSidebarCollapsed()).toBe(true);
    sessionStorage.setItem(STORAGE_KEYS.sidebarCollapsed, 'false');
    expect(readSidebarCollapsed()).toBe(false);
    // Both areas say "collapsed": only a broken storage leads back to the default (expanded).
    sessionStorage.setItem(STORAGE_KEYS.sidebarCollapsed, 'true');
    expect(readSidebarCollapsed()).toBe(true);
    // Until FIX-R5 F5 this step spied on Storage.prototype, which happy-dom ignored.
    const attempts: string[] = [];
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(brokenStorage(attempts));
    vi.spyOn(window, 'sessionStorage', 'get').mockReturnValue(brokenStorage(attempts));
    expect(readSidebarCollapsed()).toBe(false);
    expect(attempts).toEqual([
      `get ${STORAGE_KEYS.sidebarCollapsed}`,
      `get ${STORAGE_KEYS.sidebarCollapsed}`,
    ]);
  });
});

describe('SidebarFrame (V3-14, WP-58)', () => {
  it('wide window: expanded; collapse into the rail and back, remembered per window', async () => {
    await start();
    const user = userEvent.setup();
    expect(frame().dataset.state).toBe('expanded');
    expect(rail()).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    expect(frame().dataset.state).toBe('collapsed');
    expect(frame().hidden).toBe(true);
    expect(frame().hasAttribute('inert')).toBe(true);
    expect(rail()).not.toBeNull();
    expect(document.activeElement).toBe(showButton());
    expect(sessionStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBe('true');
    expect(localStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBe('true');
    // Wide: no overlay – "Show sessions" expands the sidebar again.
    expect(showButton().hasAttribute('aria-expanded')).toBe(false);

    await user.click(showButton());
    expect(frame().dataset.state).toBe('expanded');
    expect(rail()).toBeNull();
    expect(frame().contains(document.activeElement)).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBe('false');
  });

  it('a stored choice starts collapsed', async () => {
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, 'true');
    resetSidebarLayout();
    await start();
    expect(frame().dataset.state).toBe('collapsed');
    expect(rail()).not.toBeNull();
  });

  it('narrow window: rail with a status button per session; a click selects the session', async () => {
    await start();
    setWindowWidth(700);
    expect(frame().dataset.state).toBe('collapsed');
    const nav = rail();
    if (nav === null) throw new Error('rail missing');
    const auth = within(nav).getByRole('button', { name: /^Refactoring Auth-Service – / });
    expect(auth.getAttribute('aria-current')).toBe('page');
    const buttons = within(nav).getAllByRole('button');
    // WP-90: "Show sessions", "New session", "Waiting for you", settings + one per (non-archived) session.
    const sessions = document.querySelectorAll('[data-rail-session]');
    const actions = buttons.filter((button) => !button.hasAttribute('data-rail-session'));
    expect(actions.map((button) => button.dataset.action)).toEqual([
      'show-sessions',
      'rail-new-session',
      'rail-next-waiting',
      'rail-settings',
    ]);
    expect(buttons).toHaveLength(sessions.length + actions.length);
    const other = [...sessions].find((button) => button !== auth);
    if (!(other instanceof HTMLElement)) throw new Error('second session missing');
    const user = userEvent.setup();
    await user.click(other);
    expect(getSelectedSession()).toBe(other.dataset.railSession);
  });

  it('narrow window: "Show sessions" opens the overlay; Esc closes it, the focus returns', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    const show = showButton();
    expect(show.getAttribute('aria-expanded')).toBe('false');
    await user.click(show);
    expect(frame().dataset.state).toBe('overlay');
    expect(frame().hidden).toBe(false);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    expect(show.getAttribute('aria-controls')).toBe(frame().id);
    // The focus moved into the sidebar (the selected row).
    expect(document.activeElement?.getAttribute('data-session-row')).toBe(NAVIGATION_SESSION_KEYS.auth);
    expect(document.querySelector('[data-slot="sidebar-backdrop"]')).not.toBeNull();

    // The focused row shows its details tooltip: like every Radix layer, the first Esc closes it.
    if (document.querySelector('[data-radix-popper-content-wrapper]') !== null) {
      await user.keyboard('{Escape}');
      expect(frame().dataset.state).toBe('overlay');
    }
    await user.keyboard('{Escape}');
    expect(frame().dataset.state).toBe('collapsed');
    expect(document.activeElement).toBe(show);
  });

  it('narrow window: the backdrop and the collapse button close the overlay', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    await user.click(showButton());
    const backdrop = document.querySelector<HTMLElement>('[data-slot="sidebar-backdrop"]');
    if (backdrop === null) throw new Error('backdrop missing');
    await user.click(backdrop);
    expect(frame().dataset.state).toBe('collapsed');
    expect(document.activeElement).toBe(showButton());

    await user.click(showButton());
    await user.click(within(frame()).getByRole('button', { name: 'Collapse the sidebar' }));
    expect(frame().dataset.state).toBe('collapsed');
    expect(document.activeElement).toBe(showButton());
    // Closing the overlay is no collapse choice of a wide window.
    expect(localStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBeNull();
  });

  it('narrow window: choosing a session in the overlay closes it', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    await user.click(showButton());
    const rows = [...frame().querySelectorAll<HTMLElement>('[data-session-row]')];
    const target = rows.find((row) => row.dataset.sessionRow !== NAVIGATION_SESSION_KEYS.auth);
    if (target === undefined) throw new Error('second row missing');
    await user.click(target);
    expect(getSelectedSession()).toBe(target.dataset.sessionRow);
    expect(frame().dataset.state).toBe('collapsed');
  });

  it('a window that gets wide again shows the expanded sidebar (no stale overlay)', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    await user.click(showButton());
    setWindowWidth(1280);
    expect(frame().dataset.state).toBe('expanded');
    setWindowWidth(700);
    expect(frame().dataset.state).toBe('collapsed');
  });

  it('collapsed: Alt+1…9 and Ctrl+K keep working', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    const first = document.querySelector<HTMLElement>('[data-rail-session]');
    const second = document.querySelectorAll<HTMLElement>('[data-rail-session]')[1];
    if (first === null || second === undefined) throw new Error('rail sessions missing');
    await user.keyboard('{Alt>}2{/Alt}');
    expect(getSelectedSession()).toBe(second.dataset.railSession);
    await user.keyboard('{Alt>}1{/Alt}');
    expect(getSelectedSession()).toBe(first.dataset.railSession);
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Switch session' })).toBeTruthy();
  });

  it('broken localStorage: collapsing still works for this window, nothing throws', async () => {
    // Only a working localStorage would start this window collapsed (control for the spies below).
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, 'true');
    // Until FIX-R5 F5 this test spied on Storage.prototype, which happy-dom ignored: it was green
    // with a working storage.
    const attempts: string[] = [];
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(brokenStorage(attempts));
    resetSidebarLayout();
    await start();
    const user = userEvent.setup();
    expect(frame().dataset.state).toBe('expanded');
    expect(attempts).toContain(`get ${STORAGE_KEYS.sidebarCollapsed}`);
    await user.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    expect(frame().dataset.state).toBe('collapsed');
    expect(attempts).toContain(`set ${STORAGE_KEYS.sidebarCollapsed}`);
    // This window still remembers its choice.
    expect(sessionStorage.getItem(STORAGE_KEYS.sidebarCollapsed)).toBe('true');
    await user.click(showButton());
    await waitFor(() => {
      expect(frame().dataset.state).toBe('expanded');
    });
  });
});

describe('sidebar width (WP-90, GitHub #4)', () => {
  it('reads this window first, then any window; clamps to 224–480 px; junk = default', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
    localStorage.setItem(STORAGE_KEYS.sidebarWidth, '400');
    expect(readSidebarWidth()).toBe(400);
    sessionStorage.setItem(STORAGE_KEYS.sidebarWidth, '9999');
    expect(readSidebarWidth()).toBe(480);
    sessionStorage.setItem(STORAGE_KEYS.sidebarWidth, '100');
    expect(readSidebarWidth()).toBe(224);
    sessionStorage.setItem(STORAGE_KEYS.sidebarWidth, '12px');
    expect(readSidebarWidth()).toBe(400);
    expect(sidebarMaxWidth(1000)).toBe(400);
    expect(sidebarMaxWidth(2000)).toBe(480);
    expect(sidebarMaxWidth(500)).toBe(224);
  });

  function aside(): HTMLElement {
    const element = frame().querySelector<HTMLElement>('aside');
    if (element === null) throw new Error('sidebar missing');
    return element;
  }

  it('the handle changes the width by keys, remembers it and resets on double click', async () => {
    localStorage.setItem(STORAGE_KEYS.sidebarWidth, '320');
    resetSidebarLayout();
    await start();
    const user = userEvent.setup();
    expect(aside().style.width).toBe('320px');
    const handle = screen.getByRole('separator', { name: 'Sidebar width' });
    expect(handle.getAttribute('aria-valuetext')).toBe('320 px');
    handle.focus();
    await user.keyboard('{ArrowRight}');
    expect(aside().style.width).toBe('336px');
    expect(sessionStorage.getItem(STORAGE_KEYS.sidebarWidth)).toBe('336');
    expect(localStorage.getItem(STORAGE_KEYS.sidebarWidth)).toBe('336');
    await user.dblClick(handle);
    expect(aside().style.width).toBe(`${String(SIDEBAR_DEFAULT_WIDTH)}px`);
    expect(localStorage.getItem(STORAGE_KEYS.sidebarWidth)).toBe(String(SIDEBAR_DEFAULT_WIDTH));
  });

  it('moved below the minimum the sidebar collapses and keeps its width', async () => {
    await start();
    const user = userEvent.setup();
    const handle = screen.getByRole('separator', { name: 'Sidebar width' });
    handle.focus();
    await user.keyboard('{Home}');
    expect(frame().dataset.state).toBe('collapsed');
    expect(document.activeElement).toBe(showButton());
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(screen.queryByRole('separator', { name: 'Sidebar width' })).toBeNull();
    await user.click(showButton());
    expect(aside().style.width).toBe(`${String(SIDEBAR_DEFAULT_WIDTH)}px`);
  });

  it('Alt+B collapses and expands without moving the focus; in a narrow window it opens the overlay', async () => {
    await start();
    const user = userEvent.setup();
    const outside = document.createElement('button');
    document.body.append(outside);
    cleanups.push(() => {
      outside.remove();
    });
    outside.focus();
    await user.keyboard('{Alt>}b{/Alt}');
    expect(frame().dataset.state).toBe('collapsed');
    expect(document.activeElement).toBe(outside);
    await user.keyboard('{Alt>}b{/Alt}');
    expect(frame().dataset.state).toBe('expanded');
    expect(document.activeElement).toBe(outside);
    // The focus inside the sidebar goes to the rail (the sidebar is hidden).
    screen.getByRole('button', { name: 'Collapse the sidebar' }).focus();
    await user.keyboard('{Alt>}b{/Alt}');
    expect(document.activeElement).toBe(showButton());
    setWindowWidth(700);
    await user.keyboard('{Alt>}b{/Alt}');
    expect(frame().dataset.state).toBe('overlay');
  });

  it('the rail: "New session", "Waiting for you" like Alt+N, settings', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    const nav = rail();
    if (nav === null) throw new Error('rail missing');
    const before = getSelectedSession();
    await user.keyboard('{Alt>}n{/Alt}');
    const viaShortcut = getSelectedSession();
    act(() => {
      setSelectedSession(before);
    });
    await user.click(
      within(nav).getByRole('button', { name: /^Next session waiting for you \(\d+ waiting\)$/ }),
    );
    expect(getSelectedSession()).toBe(viaShortcut);
    await user.click(within(nav).getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    await user.keyboard('{Escape}');
    await user.click(within(nav).getByRole('button', { name: 'New session' }));
    expect(await screen.findByRole('dialog', { name: /New session/ })).toBeTruthy();
  });

  it('the width follows the window: capped at 40 %, back when the window grows', async () => {
    localStorage.setItem(STORAGE_KEYS.sidebarWidth, '480');
    resetSidebarLayout();
    setWindowWidth(1000);
    await start();
    expect(aside().style.width).toBe('400px');
    const handle = screen.getByRole('separator', { name: 'Sidebar width' });
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    expect(handle.getAttribute('aria-valuemax')).toBe('400');
    setWindowWidth(1600);
    expect(aside().style.width).toBe('480px');
    expect(handle.getAttribute('aria-valuemax')).toBe('480');
  });

  it('Alt+B on a rail button moves the focus into the expanded sidebar', async () => {
    await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    expect(document.activeElement).toBe(showButton());
    await user.keyboard('{Alt>}b{/Alt}');
    expect(frame().dataset.state).toBe('expanded');
    expect(frame().contains(document.activeElement)).toBe(true);
  });

  it('"Stop server" from the rail opens one dialog (the hidden sidebar hosts it)', async () => {
    await start();
    setWindowWidth(700);
    const user = userEvent.setup();
    const nav = rail();
    if (nav === null) throw new Error('rail missing');
    await user.click(within(nav).getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Stop server…' }));
    await screen.findByRole('dialog', { name: 'Stop the Parallax server?' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
