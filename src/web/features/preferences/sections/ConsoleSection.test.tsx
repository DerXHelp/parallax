import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '@shared/protocol';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { useSettingsEditor } from '../state/settings-editor';
import { ConsoleSection } from './ConsoleSection';

/** WP-97 (ADR-238): settings section "Console". */

vi.setConfig({ testTimeout: 60_000 });

let running: RunningScenario | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
});

function Section() {
  const editor = useSettingsEditor();
  return <ConsoleSection editor={editor} />;
}

async function start(): Promise<RunningScenario> {
  running = startScenario('empty', { select: null });
  render(
    <TooltipProvider>
      <Section />
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(document.querySelector('[data-slot="git-detect"][data-found]')).not.toBeNull();
  });
  return running;
}

function consoleUpdates(scenario: RunningScenario): unknown[] {
  return scenario.host.commands.flatMap((cmd: Command) =>
    cmd.name === 'settings.update' && cmd.patch.console !== undefined ? [cmd.patch.console] : [],
  );
}

describe('settings section "Console" (WP-97)', () => {
  it('cmd is the default; choosing a shell or the Git Bash window saves the whole object at once', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    expect(screen.getByRole('radio', { name: 'Command Prompt (cmd)' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: /^mintty/ }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Git Bash' }));
    await user.click(screen.getByRole('radio', { name: 'Default terminal of Windows' }));
    await waitFor(() => {
      expect(consoleUpdates(scenario)).toEqual([
        { defaultShell: 'gitbash', gitBashWindow: 'mintty', gitDir: null, terminalEmulator: null },
        { defaultShell: 'gitbash', gitBashWindow: 'terminal', gitDir: null, terminalEmulator: null },
      ]);
    });
  });

  it('shows where Git for Windows was found', async () => {
    await start();
    const line = document.querySelector('[data-slot="git-detect"]');
    expect(line?.getAttribute('data-found')).toBe('true');
    expect(line?.textContent).toContain('Git Bash found: C:\\Program Files\\Git');
  });

  it('an own Git folder: an unsafe path is refused, a local one saved on Enter, empty = detected', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const field = screen.getByRole('textbox', { name: 'Folder of Git for Windows (optional)' });
    await user.type(field, '\\\\server\\share\\Git{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('no network path');
    expect(consoleUpdates(scenario)).toEqual([]);
    await user.clear(field);
    await user.type(field, 'D:\\PortableGit{Enter}');
    await waitFor(() => {
      expect(consoleUpdates(scenario)).toEqual([
        { defaultShell: 'cmd', gitBashWindow: 'mintty', gitDir: 'D:\\PortableGit', terminalEmulator: null },
      ]);
    });
    await user.clear(field);
    await user.tab();
    await waitFor(() => {
      expect(consoleUpdates(scenario).at(-1)).toEqual({
        defaultShell: 'cmd',
        gitBashWindow: 'mintty',
        gitDir: null,
        terminalEmulator: null,
      });
    });
  });
});
