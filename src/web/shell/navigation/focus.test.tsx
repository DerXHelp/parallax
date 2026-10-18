import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { setLanguage } from '@web/i18n';
import { focusedElement } from '@web/lib/return-focus';
import { STORAGE_KEYS } from '@web/lib/storage';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { showTextNotice } from '@web/state/notices';
import { getSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { closeNewSession } from '../NewSessionDialog';
import { requestShell } from '../requests';
import { installShortcutListener } from '../shortcuts';
import { FeatureSlotsProvider, type FeatureSlots } from '../slots';
import { resetRename } from './rename';
import { sessionMenuCloseAutoFocus } from './session-actions';
import { resetSidebarView, setSidebarMode } from './sidebar-view';

// The whole shell renders per test (docs/wp/FLAKES.md): generous timeout, conditions instead of waits.
vi.setConfig({ testTimeout: 60_000 });

const KEYS = {
  colors: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.colors),
  release: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.release),
  scraper: makeSessionKey(LOCAL_HOST_ID, NAVIGATION_ENTRIES.scraper),
  ...NAVIGATION_SESSION_KEYS,
};

/** A message field per pane, like the real composer (target of `focusSessionInput`). */
function TestComposer({ sessionKey }: { sessionKey: string }) {
  return <textarea aria-label="Message" data-composer={sessionKey} />;
}

const SLOTS: Partial<FeatureSlots> = { Composer: TestComposer };

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

async function start(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(
    <FeatureSlotsProvider slots={SLOTS}>
      <AppShell />
    </FeatureSlotsProvider>,
  );
  const nav = await screen.findByRole('navigation', { name: 'Sessions' });
  await within(nav).findByText('Landing page copy');
  await screen.findByRole('heading', { level: 1 });
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

function composer(sessionKey: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-composer="${sessionKey}"]`);
  if (element === null) throw new Error(`composer ${sessionKey} missing`);
  return element;
}

function focus(element: HTMLElement): void {
  act(() => {
    element.focus();
  });
}

describe('focus after the navigation dialogs (R4W-04, V3-04)', () => {
  it('quick switcher: Esc gives the focus back to the row, Enter puts it into the chosen message field', async () => {
    await start();
    const user = userEvent.setup();
    focus(row(KEYS.release));
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Switch session' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(row(KEYS.release));
    });

    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Switch session' });
    await user.type(within(dialog).getByRole('combobox'), 'scraper');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.scraper);
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(composer(KEYS.scraper));
    });
  });

  it('quick switcher from the message field: Esc returns there', async () => {
    await start();
    const user = userEvent.setup();
    focus(composer(KEYS.auth));
    await user.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: 'Switch session' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(composer(KEYS.auth));
    });
  });

  it('session info and earlier conversations from the composer (/status, /resume): Esc returns there', async () => {
    await start();
    const user = userEvent.setup();
    focus(composer(KEYS.auth));
    act(() => {
      requestShell({ kind: 'sessionInfo', sessionKey: KEYS.auth });
    });
    await screen.findByRole('dialog', { name: 'Session info' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(composer(KEYS.auth));
    });

    act(() => {
      requestShell({ kind: 'conversations', sessionKey: KEYS.auth });
    });
    await screen.findByRole('dialog', { name: 'Earlier conversations' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(composer(KEYS.auth));
    });
  });

  it('opened from the header menu (the item is gone): the focus lands on the header "…"', async () => {
    await start();
    const user = userEvent.setup();
    const menuButton = screen.getByRole('button', { name: 'Session actions' });
    await user.click(menuButton);
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Session info…' }));
    await screen.findByRole('dialog', { name: 'Session info' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Session actions' }));
    });
  });

  it('"Pin" from the row\'s "…" menu by keyboard: the focus lands on the (moved) row', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    focus(row(KEYS.release));
    // Tab reaches "…" (shown while the row has the focus), Enter opens the menu.
    await user.tab();
    expect(document.activeElement?.getAttribute('data-slot')).toBe('row-actions');
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    const pin = within(menu).getByRole('menuitem', { name: 'Pin' });
    act(() => {
      pin.focus();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.setPinned',
        entryId: NAVIGATION_ENTRIES.release,
        pinned: true,
      });
    });
    // The pinned row moved up; the focus stays with it (its row or its "…"), never on <body>.
    await waitFor(() => {
      expect(row(KEYS.release).closest('li')?.contains(document.activeElement)).toBe(true);
    });
  });

  it('a session menu that closes with the focus on <body> (trigger gone) hands it to the row / header "…"', async () => {
    await start();
    act(() => {
      focusedElement()?.blur();
    });
    sessionMenuCloseAutoFocus(KEYS.release, 'sidebar')(new Event('focusScope.autoFocusOnUnmount'));
    await waitFor(() => {
      expect(document.activeElement).toBe(row(KEYS.release));
    });
    act(() => {
      focusedElement()?.blur();
    });
    sessionMenuCloseAutoFocus(KEYS.auth, 'header')(new Event('focusScope.autoFocusOnUnmount'));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Session actions' }));
    });
    // A focus somewhere else (e.g. a dialog the action opened) stays where it is.
    focus(composer(KEYS.auth));
    sessionMenuCloseAutoFocus(KEYS.release, 'sidebar')(new Event('focusScope.autoFocusOnUnmount'));
    // The handler's own timer (0 ms) was queued first, so it has run after this one.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(document.activeElement).toBe(composer(KEYS.auth));
  });
});

describe('quick switcher ranking (V3-03)', () => {
  it('with a query: best match first, waiting only on equal scores', async () => {
    await start();
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Switch session' });
    const options = () =>
      within(dialog)
        .getAllByRole('option')
        .map((option) => option.textContent);
    // Without a query the waiting session leads.
    expect(options()[0]).toContain('Answer the color question');
    await user.type(within(dialog).getByRole('combobox'), 'landing');
    // The title hit beats the waiting session that only lives in the folder "landing".
    expect(options()[0]).toContain('Landing page copy');
    expect(options()[1]).toContain('Answer the color question');
  });
});

describe('hints above modal dialogs (R4W-05)', () => {
  it('the region stays visible to screen readers and usable while a dialog is open', async () => {
    await start();
    act(() => {
      requestShell({ kind: 'sessionInfo', sessionKey: KEYS.auth });
    });
    const dialog = await screen.findByRole('dialog', { name: 'Session info' });
    act(() => {
      showTextNotice('navigation.console.copyFailed', undefined, { id: 'focus-test', durationMs: null });
    });
    // Not hidden from the accessibility tree by the modal dialog (no aria-hidden ancestor).
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.closest('[aria-hidden="true"]')).toBeNull();
    const notice = await within(region).findByText(/could not be copied/);
    // Dismissing the hint is no click "outside" that closes the dialog.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const card = notice.closest<HTMLElement>('[data-notice]');
    if (card === null) throw new Error('card missing');
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(within(region).queryByText(/could not be copied/)).toBeNull();
    });
    expect(dialog.isConnected).toBe(true);
  });
});

describe('keyboard behind dialogs and menus (R4W-11, R4W-12)', () => {
  it('Alt+1…9 and Ctrl+K do nothing while a modal dialog is open', async () => {
    await start();
    const user = userEvent.setup();
    act(() => {
      requestShell({ kind: 'sessionInfo', sessionKey: KEYS.auth });
    });
    await screen.findByRole('dialog', { name: 'Session info' });
    await user.keyboard('{Alt>}1{/Alt}');
    await user.keyboard('{Control>}k{/Control}');
    expect(getSelectedSession()).toBe(KEYS.auth);
    expect(screen.queryByRole('dialog', { name: 'Switch session' })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Session info' })).toBeNull();
    });
    // Closed again: the shortcuts work.
    await user.keyboard('{Alt>}1{/Alt}');
    await waitFor(() => {
      expect(getSelectedSession()).toBe(KEYS.landing);
    });
  });

  it('arrow keys inside a row menu never move the focus to a sidebar row', async () => {
    await start();
    const user = userEvent.setup();
    focus(row(KEYS.release));
    const item = row(KEYS.release).closest('li');
    if (item === null) throw new Error('row item missing');
    // Before the menu opens (it hides the rest of the page from the accessibility tree).
    const list = nav();
    await user.click(within(item).getByRole('button', { name: /Actions for/ }));
    const menu = await screen.findByRole('menu');
    const rowFocus = vi.fn();
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-session-row]') !== null) rowFocus();
    };
    list.addEventListener('focusin', onFocus);
    cleanups.push(() => {
      list.removeEventListener('focusin', onFocus);
    });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(rowFocus).not.toHaveBeenCalled();
    expect(menu.contains(document.activeElement)).toBe(true);
  });
});

describe('sidebar details (R4W-13, V3-12, V3-14)', () => {
  it('archive and group buttons are no tab stops; restoring the last archived session leaves the archive', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    act(() => {
      setSidebarMode('grouped');
    });
    const plus = await within(nav()).findAllByRole('button', { name: 'New session in this project…' });
    expect(plus.every((button) => button.tabIndex === -1)).toBe(true);
    act(() => {
      setSidebarMode('flat');
    });

    await user.click(screen.getByRole('button', { name: 'Archive (2)' }));
    await waitFor(() => {
      expect(nav().dataset.view).toBe('archive');
    });
    const restore = within(nav()).getAllByRole('button', { name: 'Restore' });
    expect(restore).toHaveLength(2);
    expect(restore.every((button) => button.tabIndex === -1)).toBe(true);
    for (const button of restore) await user.click(button);
    await waitFor(() => {
      expect(scenario.host.commands.filter((cmd) => cmd.name === 'session.setArchived')).toHaveLength(2);
    });
    // No empty "Archive (0)": back to the sessions.
    await waitFor(() => {
      expect(nav().dataset.view).toBe('flat');
    });
    expect(screen.queryByRole('button', { name: /^Archive/ })).toBeNull();
  });

  it('the row context menu has a name', async () => {
    await start();
    fireEvent.contextMenu(row(KEYS.release));
    expect(await screen.findByRole('menu', { name: 'Actions for “Release notes 2.4”' })).toBeTruthy();
  });
});
