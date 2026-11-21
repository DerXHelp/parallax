import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { updateSettings } from '@web/state/settings';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { registerShellRequestHandler } from '../requests';
import { getSidePanelTab } from '../side-panel/state';
import { FeatureSlotsProvider, type FeatureSlots } from '../slots';
import { installShortcutListener } from '../shortcuts';
import { resetRename } from './rename';
import { resetSidebarView } from './sidebar-view';

/** WP-97 (ADR-238): "Open shell in folder" – header button, submenu of the "…" menu, Alt+K. */

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

/**
 * WP-99: stand-ins for the terminal feature (a panel with an active view and xterm's text area,
 * focused on mount like the real one) and the composer (target of `focusSessionInput`).
 */
function TestTerminalPanel(_props: { sessionKey: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div data-slot="terminal-panel">
      <div data-slot="terminal-view" data-active="true">
        <textarea ref={input} aria-label="Terminal input" className="xterm-helper-textarea" />
      </div>
    </div>
  );
}

function TestComposer(_props: { sessionKey: string }) {
  return (
    <div data-slot="composer">
      <textarea aria-label="Message" />
    </div>
  );
}

const SLOTS: Partial<FeatureSlots> = { TerminalPanel: TestTerminalPanel, Composer: TestComposer };

async function start(options: { terminal?: boolean } = {}): Promise<RunningScenario> {
  running = startScenario('navigation');
  if (options.terminal === true)
    running.host.setHostState({ ...running.host.hostState, terminalAvailable: true });
  cleanups.push(installShortcutListener());
  render(
    <FeatureSlotsProvider slots={SLOTS}>
      <AppShell />
    </FeatureSlotsProvider>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Refactoring Auth-Service' });
  return running;
}

function shellCommands(scenario: RunningScenario) {
  return scenario.host.commands.filter((cmd) => cmd.name === 'session.openShell');
}

describe('header button (WP-97)', () => {
  it('opens the default shell; the chevron offers every shell and the console settings', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const group = screen.getByRole('group', { name: 'Shell in the project folder' });
    await user.click(
      within(group).getByRole('button', { name: 'Open Command Prompt (cmd) in the project folder' }),
    );
    await waitFor(() => {
      expect(shellCommands(scenario)).toEqual([
        { name: 'session.openShell', entryId: NAVIGATION_ENTRIES.auth, shell: 'cmd' },
      ]);
    });

    await user.click(within(group).getByRole('button', { name: 'Choose shell' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Command Prompt (cmd)DefaultAlt+K', 'PowerShell', 'Git Bash', 'Console settings…']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Git Bash' }));
    await waitFor(() => {
      expect(shellCommands(scenario).at(-1)).toEqual({
        name: 'session.openShell',
        entryId: NAVIGATION_ENTRIES.auth,
        shell: 'gitbash',
      });
    });

    const sections: (string | undefined)[] = [];
    cleanups.push(
      registerShellRequestHandler('settings', (request) => {
        sections.push(request.section);
        return true;
      }),
    );
    await user.click(within(group).getByRole('button', { name: 'Choose shell' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Console settings…' }));
    expect(sections).toEqual(['console']);
  });

  it('follows the default shell of the settings', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await act(async () => {
      await updateSettings({
        console: {
          defaultShell: 'powershell',
          gitBashWindow: 'mintty',
          gitDir: null,
          terminalEmulator: null,
        },
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Open PowerShell in the project folder' }));
    await waitFor(() => {
      expect(shellCommands(scenario).at(-1)).toMatchObject({ shell: 'powershell' });
    });
  });
});

describe('"…" menu and Alt+K (WP-97)', () => {
  it('the submenu opens the chosen shell', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    const menu = await screen.findByRole('menu');
    // By keyboard: the pointer grace area of a submenu needs real geometry (happy-dom has none).
    act(() => {
      within(menu).getByRole('menuitem', { name: 'Open shell in folder' }).focus();
    });
    await user.keyboard('{ArrowRight}');
    const sub = await screen.findByRole('menuitem', { name: 'PowerShell' });
    await waitFor(() => {
      expect(document.activeElement?.textContent).toContain('Command Prompt (cmd)');
    });
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(sub);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(shellCommands(scenario)).toEqual([
        { name: 'session.openShell', entryId: NAVIGATION_ENTRIES.auth, shell: 'powershell' },
      ]);
    });
  });

  it('Alt+K opens the default shell of the selected session', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.keyboard('{Alt>}k{/Alt}');
    await waitFor(() => {
      expect(shellCommands(scenario)).toEqual([
        { name: 'session.openShell', entryId: NAVIGATION_ENTRIES.auth, shell: 'cmd' },
      ]);
    });
  });
});

describe('"Terminal in panel" (WP-99)', () => {
  const SESSION = NAVIGATION_SESSION_KEYS.auth;

  it('is offered only when this computer has a pseudo console', async () => {
    await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose shell' }));
    expect(
      within(await screen.findByRole('menu')).queryByRole('menuitem', { name: /Terminal in panel/ }),
    ).toBeNull();
  });

  it('the chevron opens the terminal tab and focuses the terminal', async () => {
    await start({ terminal: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose shell' }));
    await user.click(await screen.findByRole('menuitem', { name: /Terminal in panel/ }));
    await waitFor(() => {
      expect(getSidePanelTab(SESSION)).toBe('terminal');
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Terminal input' }));
    });
  });

  it('Alt+T opens the terminal; Alt+T in the terminal goes back to the message field', async () => {
    await start({ terminal: true });
    const user = userEvent.setup();
    // From the message field (the start focuses it a few frames later – wait for that first).
    const message = screen.getByRole('textbox', { name: 'Message' });
    await user.click(message);
    await waitFor(() => {
      expect(document.activeElement).toBe(message);
    });
    await user.keyboard('{Alt>}t{/Alt}');
    const input = await screen.findByRole('textbox', { name: 'Terminal input' });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    await user.keyboard('{Alt>}t{/Alt}');
    await waitFor(() => {
      expect(document.activeElement?.closest('[data-slot="composer"]')).not.toBeNull();
    });
    expect(getSidePanelTab(SESSION)).toBe('terminal');
  });

  it('the "…" menu has "Terminal in panel" with Alt+T', async () => {
    await start({ terminal: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    const item = within(await screen.findByRole('menu')).getByRole('menuitem', { name: /Terminal in panel/ });
    expect(item.textContent).toContain('Alt+T');
  });
});
