/**
 * WP-64 §1.4 in the shell: Remote Control on/off from the session menus, the phone icon in the
 * sidebar row and in the header (state colours, tooltip/status with the readable error), the
 * header's own menu with "Open in the Claude app" (only claude.ai links) and "Copy link".
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { RemoteControlSummary } from '@shared/model';
import { SAMPLE_IDS, sampleHostState, sampleSummary } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { AppShell } from '../AppShell';
import { SessionHeader } from '../SessionHeader';
import { installShortcutListener } from '../shortcuts';
import { REMOTE_ACTIONS } from './RemoteControlMenu';
import { remoteLinkOf, showsRemoteInHeader, showsRemoteInRow } from './remote-control';
import { resetRename } from './rename';
import { HEADER_ACTIONS, SIDEBAR_ACTIONS } from './session-actions';
import { resetSidebarView } from './sidebar-view';

vi.setConfig({ testTimeout: 60_000 });

const KEY = makeSessionKey(LOCAL_HOST_ID, SAMPLE_IDS.entry);
const URL = 'https://claude.ai/code/session_01abc';

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
  vi.restoreAllMocks();
});

function remote(p: Partial<RemoteControlSummary> = {}): RemoteControlSummary {
  return { state: 'connected', sessionUrl: URL, error: null, wanted: true, ...p };
}

function renderHeader(remoteControl: RemoteControlSummary): void {
  clientStore.setState({
    hosts: {
      [LOCAL_HOST_ID]: {
        ...emptyHostRecord(LOCAL_HOST_ID),
        hostState: sampleHostState(),
        summaries: { [SAMPLE_IDS.entry]: sampleSummary({ remoteControl }) },
      },
    },
  });
  render(
    <TooltipProvider>
      <SessionHeader sessionKey={KEY} />
    </TooltipProvider>,
  );
}

function headerButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>('[data-slot="header-remote"]');
  if (button === null) throw new Error('no Remote Control button in the header');
  return button;
}

describe('Remote Control helpers (WP-64)', () => {
  it('row: only a live state; header: also a wanted, dormant session; links only from claude.ai', () => {
    expect(showsRemoteInRow(remote({ state: 'off', wanted: true }))).toBe(false);
    expect(showsRemoteInHeader(remote({ state: 'off', wanted: true }))).toBe(true);
    expect(showsRemoteInHeader(remote({ state: 'off', wanted: false }))).toBe(false);
    expect(showsRemoteInRow(remote({ state: 'failed' }))).toBe(true);
    expect(remoteLinkOf(remote())).toBe(URL);
    expect(remoteLinkOf(remote({ sessionUrl: 'https://claude.ai.evil.com/x' }))).toBeNull();
    expect(remoteLinkOf(remote({ sessionUrl: 'http://claude.ai/code/x' }))).toBeNull();
    expect(remoteLinkOf(remote({ sessionUrl: null }))).toBeNull();
    // The same three actions in every session menu.
    for (const slots of [SIDEBAR_ACTIONS, HEADER_ACTIONS]) {
      for (const id of REMOTE_ACTIONS) expect(slots).toContain(id);
    }
  });
});

describe('Remote Control in the header (WP-64)', () => {
  it('off and not wanted: no icon', () => {
    renderHeader(remote({ state: 'off', wanted: false, sessionUrl: null }));
    expect(document.querySelector('[data-slot="header-remote"]')).toBeNull();
  });

  it.each([
    ['connected', 'text-muted-foreground', 'Remote Control: connected – open in the Claude app'],
    ['connecting', 'opacity-50', 'Remote Control: connecting…'],
    ['reconnecting', 'opacity-50', 'Remote Control: connection lost, reconnecting…'],
  ] as const)('%s: icon tone and status as the accessible name', (state, tone, name) => {
    renderHeader(remote({ state }));
    const button = headerButton();
    expect(button.dataset.remoteState).toBe(state);
    expect(button.getAttribute('aria-label')).toBe(name);
    expect(button.querySelector('svg')?.getAttribute('class')).toContain(tone);
  });

  it('failed: warning colour and the readable error (login hint)', async () => {
    renderHeader(remote({ state: 'failed', sessionUrl: null, error: makeError('REMOTE_CONTROL_AUTH') }));
    const button = headerButton();
    expect(button.querySelector('svg')?.getAttribute('class')).toContain('text-warning');
    expect(button.getAttribute('aria-label')).toContain('/login');
    const user = userEvent.setup();
    await user.click(button);
    const menu = await screen.findByRole('menu');
    // WP-70: the error names "Sign in" (the terminal only as the fallback) – and the menu has it.
    expect(within(menu).getByText(/Use “Sign in” – or run “claude” in a terminal/)).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Sign in' })).toBeTruthy();
    // No link: neither open nor copy.
    expect(within(menu).queryByRole('menuitem', { name: 'Open in the Claude app' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Turn off Remote Control' })).toBeTruthy();
  });

  it('wanted but dormant: muted icon, "connects when the session starts"', () => {
    renderHeader(remote({ state: 'off', wanted: true, sessionUrl: URL }));
    expect(headerButton().getAttribute('aria-label')).toBe(
      'Remote Control: connects when the session starts',
    );
  });

  it('menu: "Open in the Claude app" opens only the claude.ai link (no opener), "Copy link" copies it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderHeader(remote());
    const user = userEvent.setup();
    await user.click(headerButton());
    await user.click(await screen.findByRole('menuitem', { name: 'Open in the Claude app' }));
    expect(open).toHaveBeenCalledWith(URL, '_blank', 'noopener,noreferrer');

    await user.click(headerButton());
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Remote Control link' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(URL);
  });

  it('a link that is not claude.ai is never offered', async () => {
    renderHeader(remote({ sessionUrl: 'https://claude.ai.evil.com/code/x' }));
    const user = userEvent.setup();
    await user.click(headerButton());
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Open in the Claude app' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Copy Remote Control link' })).toBeNull();
  });

  it('German texts', async () => {
    act(() => {
      setLanguage('de');
    });
    renderHeader(remote());
    expect(headerButton().getAttribute('aria-label')).toBe(
      'Remote Control: verbunden – in der Claude-App offen',
    );
    const user = userEvent.setup();
    await user.click(headerButton());
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Remote Control ausschalten' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'In der Claude-App öffnen' })).toBeTruthy();
  });
});

describe('Remote Control through the session menu (WP-64, fake host)', () => {
  function row(sessionKey: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-session-row="${sessionKey}"]`);
    if (element === null) throw new Error(`row ${sessionKey} missing`);
    return element;
  }

  it('on → command, phone icon in the row; off → command, icon gone', async () => {
    running = startScenario('navigation');
    cleanups.push(installShortcutListener());
    render(<AppShell />);
    const nav = await screen.findByRole('navigation', { name: 'Sessions' });
    await within(nav).findByText('Landing page copy');
    const key = NAVIGATION_SESSION_KEYS.auth;
    const user = userEvent.setup();
    expect(row(key).querySelector('[data-slot="row-remote"]')).toBeNull();

    fireEvent.contextMenu(row(key));
    let menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Turn on Remote Control' }));
    const scenario = running;
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.setRemoteControl',
        entryId: NAVIGATION_ENTRIES.auth,
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(row(key).querySelector('[data-slot="row-remote"]')?.getAttribute('data-remote-state')).toBe(
        'connected',
      );
    });
    expect(within(row(key)).getByText('Remote Control: connected – open in the Claude app')).toBeTruthy();

    fireEvent.contextMenu(row(key));
    menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: 'Turn off Remote Control' }));
    await waitFor(() => {
      expect(row(key).querySelector('[data-slot="row-remote"]')).toBeNull();
    });
    expect(scenario.host.commands).toContainEqual({
      name: 'session.setRemoteControl',
      entryId: NAVIGATION_ENTRIES.auth,
      enabled: false,
    });
  });
});
