import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@web/i18n';
import { NAVIGATION_ENTRIES } from '@web/playground/navigation-scenario';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { updateSettings } from '@web/state/settings';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { registerShellRequestHandler } from '../requests';
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

async function start(): Promise<RunningScenario> {
  running = startScenario('navigation');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
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
        console: { defaultShell: 'powershell', gitBashWindow: 'mintty', gitDir: null },
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
