import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import { sampleSummary, sampleTime } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { getSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { installShortcutListener } from '../shortcuts';
import { CLEANUP_OLDER_THAN_DAYS, olderThan } from './ArchiveCleanupDialog';
import { resetRemoveDialog } from './remove-session';
import { resetRename } from './rename';
import { resetSidebarView } from './sidebar-view';

// The whole shell renders per test (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

const KEYS = {
  ...NAVIGATION_SESSION_KEYS,
  redirect: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.redirect),
  spike: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.spike),
};

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => {
    resetRemoveDialog();
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

async function start(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  await within(nav()).findByText('Landing page copy');
  return running;
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sessions' });
}

/** The rows of the sidebar (also while a modal dialog hides the rest from the accessibility tree). */
function rowKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>('nav [data-session-row]')].map(
    (element) => element.dataset.sessionRow ?? '',
  );
}

function row(sessionKey: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]`);
  if (element === null) throw new Error(`row ${sessionKey} missing`);
  return element;
}

async function openRemoveDialog(
  user: ReturnType<typeof userEvent.setup>,
  sessionKey: string,
): Promise<HTMLElement> {
  fireEvent.contextMenu(row(sessionKey));
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitem', { name: 'Remove from Parallax…' }));
  return screen.findByRole('dialog', { name: 'Remove session from Parallax?' });
}

describe('remove a session from Parallax (WP-63 §1.3)', () => {
  it('menu → confirmation → session.remove; the open view goes back to the overview', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    expect(getSelectedSession()).toBe(KEYS.auth);
    const dialog = await openRemoveDialog(user, KEYS.auth);
    // The files stay; the idle process is closed first (no "working" warning).
    expect(dialog.textContent).toContain('“Refactoring Auth-Service” disappears from the list');
    expect(dialog.textContent).toContain('“claude --resume” keeps working');
    expect(dialog.textContent).toContain('The Claude Code process of this session is closed first.');
    expect(dialog.querySelector('[data-slot="remove-working"]')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.remove',
        entryId: NAVIGATION_ENTRIES.auth,
      });
    });
    await waitFor(() => {
      expect(rowKeys()).not.toContain(KEYS.auth);
    });
    expect(getSelectedSession()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a working session: the dialog warns that the turn ends; Cancel sends nothing', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const dialog = await openRemoveDialog(user, KEYS.redirect);
    expect(within(dialog).getByText(/This session is working right now/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(scenario.host.commands.some((cmd) => cmd.name === 'session.remove')).toBe(false);
    expect(rowKeys()).toContain(KEYS.redirect);
  });

  it('a refusal stays in the dialog (Alert role="alert"), the session stays', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    scenario.host.failNext('session.remove', makeError('SESSION_BUSY'));
    const dialog = await openRemoveDialog(user, KEYS.landing);
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The session is busy.');
    expect(rowKeys()).toContain(KEYS.landing);
  });

  it('the header menu offers it too', async () => {
    await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Remove from Parallax…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove session from Parallax?' });
    expect(dialog.textContent).toContain('Refactoring Auth-Service');
  });

  it('removed in another window: the open view goes back to the overview', async () => {
    const scenario = await start();
    expect(getSelectedSession()).toBe(KEYS.auth);
    act(() => {
      scenario.host.removeSummary(NAVIGATION_ENTRIES.auth);
    });
    await waitFor(() => {
      expect(getSelectedSession()).toBeNull();
    });
  });
});

describe('clean up the archive (WP-63 §1.3)', () => {
  async function openCleanup(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: 'Archive (2)' }));
    await user.click(within(nav()).getByRole('button', { name: 'Clean up archive…' }));
    return screen.findByRole('dialog', { name: 'Clean up archive' });
  }

  function cleanupRows(dialog: HTMLElement): string[] {
    return [...dialog.querySelectorAll<HTMLElement>('[data-cleanup-row]')].map(
      (element) => element.dataset.cleanupRow ?? '',
    );
  }

  it('checkboxes, "older than 30 days", Remove (n); a partial failure stays selected and listed', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    // The spike is 40 days old, the prototype 9 days.
    act(() => {
      scenario.host.patchSummary(NAVIGATION_ENTRIES.spike, {
        lastActivityAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      });
    });
    const dialog = await openCleanup(user);
    expect(cleanupRows(dialog)).toEqual([KEYS.prototype, KEYS.spike]);
    const removeButton = (): HTMLElement => within(dialog).getByRole('button', { name: /^Remove/ });
    expect(removeButton().hasAttribute('disabled')).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Older than 30 days' }));
    expect(removeButton().textContent).toBe('Remove (1)');
    expect(
      within(dialog)
        .getByRole('checkbox', { name: /Spike: WebGPU renderer/ })
        .getAttribute('aria-checked'),
    ).toBe('true');

    await user.click(within(dialog).getByRole('checkbox', { name: 'Select all' }));
    expect(removeButton().textContent).toBe('Remove (2)');

    scenario.host.failNext('session.remove', makeError('SESSION_BUSY'));
    await user.click(removeButton());
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('1 session could not be removed:');
    expect(alert.textContent).toContain('Old prototype: The session is busy.');
    await waitFor(() => {
      expect(cleanupRows(dialog)).toEqual([KEYS.prototype]);
    });
    // The failed one stays selected: a second try removes it.
    expect(removeButton().textContent).toBe('Remove (1)');
    await user.click(removeButton());
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      scenario.host.commands.flatMap((cmd) => (cmd.name === 'session.remove' ? [cmd.entryId] : [])),
    ).toEqual([NAVIGATION_ENTRIES.prototype, NAVIGATION_ENTRIES.spike, NAVIGATION_ENTRIES.prototype]);
    // The archive is empty: its toggle is gone and the list shows the sessions again.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull();
    });
    expect(rowKeys()).not.toContain(KEYS.prototype);
    expect(rowKeys()).not.toContain(KEYS.spike);
  });

  it('olderThan: last activity before now minus the days', () => {
    const now = Date.parse(sampleTime());
    const entry = (sessionKey: string, daysAgo: number) => ({
      sessionKey,
      hostId: LOCAL_HOST_ID,
      summary: sampleSummary({ lastActivityAt: new Date(now - daysAgo * 86_400_000).toISOString() }),
    });
    expect(olderThan([entry('a', 31), entry('b', 30), entry('c', 2)], now, CLEANUP_OLDER_THAN_DAYS)).toEqual([
      'a',
    ]);
  });
});
