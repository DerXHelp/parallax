import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { STORAGE_KEYS } from '@web/lib/storage';
import { getSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { AppShell } from './AppShell';
import { resetRename } from './navigation/rename';
import { resetSidebarView } from './navigation/sidebar-view';
import { installShortcutListener } from './shortcuts';
import {
  isNarrowWindow,
  NARROW_WINDOW_BELOW,
  readSidebarCollapsed,
  resetSidebarLayout,
} from './sidebar-layout';

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
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readSidebarCollapsed()).toBe(false);
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
    // "Show sessions" + one per (non-archived) session.
    const sessions = document.querySelectorAll('[data-rail-session]');
    expect(buttons).toHaveLength(sessions.length + 1);
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
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    resetSidebarLayout();
    await start();
    const user = userEvent.setup();
    expect(frame().dataset.state).toBe('expanded');
    await user.click(screen.getByRole('button', { name: 'Collapse the sidebar' }));
    expect(frame().dataset.state).toBe('collapsed');
    await user.click(showButton());
    await waitFor(() => {
      expect(frame().dataset.state).toBe('expanded');
    });
  });
});
