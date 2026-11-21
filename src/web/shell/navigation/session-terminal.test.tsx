import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, type TerminalId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { HostCapabilities } from '@shared/model';
import type { Command } from '@shared/protocol';
import { setLanguage } from '@web/i18n';
import {
  NAVIGATION_ENTRIES,
  NAVIGATION_SESSION_KEYS,
  navigationCommands,
  navigationData,
} from '@web/playground/navigation-scenario';
import { createHostConnection, registerConnection, unregisterConnection } from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { selectSummary } from '@web/state/hooks';
import { setSelectedSession } from '@web/state/selection';
import { selectSettings } from '@web/state/settings';
import { clientStore, resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { AppShell } from '../AppShell';
import { getSidePanelTab } from '../side-panel/state';
import { FeatureSlotsProvider, type FeatureSlots } from '../slots';
import { installShortcutListener } from '../shortcuts';
import { resetHandoffs } from './handoff';
import { resetRename } from './rename';
import { resetHostShells, resetTerminalTargets, useTerminalTarget } from './session-actions';
import { resetSidebarView } from './sidebar-view';

/**
 * WP-105: "Continue in terminal" (102e) and the shells of a Linux computer (`shell.detect`) in the
 * session menus and the header's console button.
 */

vi.setConfig({ testTimeout: 60_000 });

const SESSION = NAVIGATION_SESSION_KEYS.auth;
const CLAUDE_TERMINAL: TerminalId = `tm_${'c'.repeat(32)}`;
const LINUX_CWD = '/home/demo/auth-service';
const LINUX_DESKTOP: HostCapabilities = {
  desktop: true,
  externalConsole: true,
  shellWindow: true,
  editor: true,
  fileManager: true,
  autostart: true,
  protocolHandler: true,
};

let host: FakeHost | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => {
    resetRename();
    resetSidebarView();
    resetHandoffs();
    resetHostShells();
    resetTerminalTargets();
    setLanguage('en');
  });
  unregisterConnection(LOCAL_HOST_ID);
  host?.dispose();
  host = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

/** Stand-in of the terminal feature: shows the terminal the shell asked it to make active. */
function TestTerminalPanel({ sessionKey }: { sessionKey: string }) {
  const target = useTerminalTarget(sessionKey);
  return <div data-slot="terminal-panel" data-target={target?.terminalId ?? ''} />;
}

const SLOTS: Partial<FeatureSlots> = { TerminalPanel: TestTerminalPanel };

/** WP-105 commands of the fake host; everything else as in the navigation scenario. */
function commands(cmd: Command, fake: FakeHost): FakeAck | undefined {
  if (cmd.name === 'session.openInTerminal') {
    fake.patchSummary(
      cmd.entryId,
      { external: { since: fake.now(), pid: null, running: true, terminalId: CLAUDE_TERMINAL } },
      { runState: 'external' },
    );
    return { ok: true, result: { terminalId: CLAUDE_TERMINAL } };
  }
  if (cmd.name === 'session.openShell' && cmd.shell === 'zsh') {
    return { ok: false, error: makeError('SHELL_NOT_FOUND', { shell: 'zsh' }) };
  }
  return navigationCommands(cmd, fake);
}

/** The navigation scenario with own commands; `linux`: the computer is a Linux desktop. */
async function start(options: { terminal?: boolean; linux?: boolean } = {}): Promise<FakeHost> {
  const settings = selectSettings(clientStore.getState());
  resetClientStore();
  clientStore.setState({ localSettings: settings });
  const transport = createMemoryTransport();
  const data = navigationData(Date.now(), settings);
  const linux = options.linux === true;
  const fake = new FakeHost({
    transport,
    replyToPrompts: true,
    ...data,
    hostState: {
      ...data.hostState,
      terminalAvailable: options.terminal === true,
      ...(linux ? { platform: 'linux', capabilities: LINUX_DESKTOP } : {}),
    },
    summaries: data.summaries.map((summary) =>
      linux && summary.entryId === NAVIGATION_ENTRIES.auth ? { ...summary, cwd: LINUX_CWD } : summary,
    ),
    onCommand: commands,
  });
  host = fake;
  let reloadAt: number | null = null;
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    store: clientStore,
    createTransport: () => transport,
    reload: () => undefined,
    reloadGuard: {
      read: () => reloadAt,
      write: (at) => {
        reloadAt = at;
      },
    },
  });
  registerConnection(connection);
  connection.start();
  setSelectedSession(SESSION, { store: clientStore, updateHash: false });
  cleanups.push(installShortcutListener());
  render(
    <FeatureSlotsProvider slots={SLOTS}>
      <AppShell />
    </FeatureSlotsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Refactoring Auth-Service' });
  return fake;
}

async function openSessionMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Session actions' }));
  return screen.findByRole('menu');
}

function sent(fake: FakeHost, name: Command['name']): Command[] {
  return fake.commands.filter((cmd) => cmd.name === name);
}

describe('"Continue in terminal" (WP-105)', () => {
  it('is offered only where the session’s computer has a pseudo console', async () => {
    await start();
    const user = userEvent.setup();
    const menu = await openSessionMenu(user);
    expect(within(menu).queryByRole('menuitem', { name: 'Continue in terminal' })).toBeNull();
  });

  it('hands the session to a claude terminal and opens the panel at it; then "Show terminal with claude"', async () => {
    const fake = await start({ terminal: true });
    const user = userEvent.setup();
    let menu = await openSessionMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Continue in terminal' }));
    await waitFor(() => {
      expect(sent(fake, 'session.openInTerminal')).toEqual([
        { name: 'session.openInTerminal', entryId: NAVIGATION_ENTRIES.auth },
      ]);
    });
    await waitFor(() => {
      expect(getSidePanelTab(SESSION)).toBe('terminal');
    });
    const panel = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="terminal-panel"]');
      expect(found).not.toBeNull();
      return found;
    });
    expect(panel?.getAttribute('data-target')).toBe(CLAUDE_TERMINAL);

    // claude runs in the terminal: the menu jumps there instead of handing off again.
    await waitFor(() => {
      expect(selectSummary(clientStore.getState(), SESSION)?.external?.terminalId).toBe(CLAUDE_TERMINAL);
    });
    menu = await openSessionMenu(user);
    expect(within(menu).queryByRole('menuitem', { name: 'Continue in terminal' })).toBeNull();
    expect(
      within(menu).getByRole('menuitem', { name: 'Open in external console' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await user.click(within(menu).getByRole('menuitem', { name: 'Show terminal with claude' }));
    await waitFor(() => {
      expect(document.querySelector('[data-slot="terminal-panel"]')?.getAttribute('data-target')).toBe(
        CLAUDE_TERMINAL,
      );
    });
    expect(sent(fake, 'session.openInTerminal')).toHaveLength(1);
  });

  it('is disabled for a session without a conversation', async () => {
    await start({ terminal: true });
    const user = userEvent.setup();
    // A session that never talked to claude has nothing to resume.
    act(() => {
      host?.patchSummary(NAVIGATION_ENTRIES.auth, { sessionId: null });
    });
    const menu = await openSessionMenu(user);
    expect(
      within(menu).getByRole('menuitem', { name: 'Continue in terminal' }).getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('shells of a Linux computer (WP-105)', () => {
  it('a Windows computer is never asked (its three shells are fixed)', async () => {
    const fake = await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose shell' }));
    await screen.findByRole('menu');
    expect(sent(fake, 'shell.detect')).toEqual([]);
  });

  it('the header offers the detected shells, asked once; a missing shell is named in the notice', async () => {
    const fake = await start({ linux: true });
    const user = userEvent.setup();
    const group = screen.getByRole('group', { name: 'Shell in the project folder' });
    await user.click(within(group).getByRole('button', { name: 'Choose shell' }));
    await waitFor(() => {
      expect(
        within(screen.getByRole('menu'))
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['Login shellDefaultAlt+K', 'Bash', 'Zsh', 'Console settings…']);
    });
    expect(sent(fake, 'shell.detect')).toHaveLength(1);

    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Zsh' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(region).findByText('Zsh is not installed on this computer.')).toBeTruthy();

    // The "…" menu builds its submenu from the same answer – no second request. By keyboard: the
    // pointer grace area of a submenu needs real geometry (happy-dom has none).
    const menu = await openSessionMenu(user);
    act(() => {
      within(menu).getByRole('menuitem', { name: 'Open shell in folder' }).focus();
    });
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('menuitem', { name: 'Zsh' });
    const choices = Array.from(document.querySelectorAll('[data-action="openShell"][data-choice]')).map(
      (item) => item.getAttribute('data-choice'),
    );
    expect(choices).toEqual(['login', 'bash', 'zsh']);
    expect(sent(fake, 'shell.detect')).toHaveLength(1);
  });
});
