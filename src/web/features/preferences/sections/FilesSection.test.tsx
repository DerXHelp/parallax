import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { EditorSettings } from '@shared/model';
import type { Command } from '@shared/protocol';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { useSettingsEditor } from '../state/settings-editor';
import { FilesSection } from './FilesSection';

vi.setConfig({ testTimeout: 60_000 });

let running: RunningScenario | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
});

function Section() {
  const editor = useSettingsEditor();
  return <FilesSection editor={editor} />;
}

/** The empty scenario (FakeHost: Notepad++ found, VS Code not), optionally with a stored editor. */
async function start(editor?: EditorSettings, prepare?: (scenario: RunningScenario) => void) {
  running = startScenario('empty', { select: null });
  const scenario = running;
  if (editor !== undefined) {
    scenario.host.setHostState({
      ...scenario.host.hostState,
      settings: { ...scenario.host.hostState.settings, editor },
    });
  }
  prepare?.(scenario);
  render(
    <TooltipProvider>
      <Section />
    </TooltipProvider>,
  );
  if (prepare === undefined) {
    await waitFor(() => {
      expect(document.querySelector('[data-slot="editor-detect"][data-found]')).not.toBeNull();
    });
  }
  return scenario;
}

function updates(scenario: RunningScenario): Command[] {
  return scenario.host.commands.filter((cmd) => cmd.name === 'settings.update');
}

function radio(name: RegExp): HTMLElement {
  return screen.getByRole('radio', { name });
}

describe('settings section "Files" (WP-58)', () => {
  it('offers the four editors, Notepad++ as default, with what editor.detect found', async () => {
    const scenario = await start();
    expect(screen.getAllByRole('radio').map((item) => item.getAttribute('value'))).toEqual([
      'notepadpp',
      'vscode',
      'custom',
      'system',
    ]);
    const notepad = radio(/^Notepad\+\+/);
    expect(notepad.getAttribute('aria-checked')).toBe('true');
    expect(within(notepad.closest('[data-preset]') ?? document.body).getByText('Default')).toBeTruthy();
    expect(screen.getByText('Found: C:\\Program Files\\Notepad++\\notepad++.exe')).toBeTruthy();
    expect(screen.getByText('Not found on this computer')).toBeTruthy();
    expect(scenario.host.commands).toContainEqual({ name: 'editor.detect' });
    // The detection describes its radio.
    const detect = document.querySelector('[data-slot="editor-detect"][data-preset="notepadpp"]');
    expect(notepad.getAttribute('aria-describedby')).toBe(detect?.id);
  });

  it('choosing VS Code or the default program saves at once – exactly settings.update {editor}', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.click(radio(/^Visual Studio Code/));
    await waitFor(() => {
      expect(updates(scenario)).toEqual([
        { name: 'settings.update', patch: { editor: { preset: 'vscode', executable: null, args: [] } } },
      ]);
    });
    await user.click(radio(/^Windows default program/));
    await waitFor(() => {
      expect(updates(scenario).at(-1)).toEqual({
        name: 'settings.update',
        patch: { editor: { preset: 'system', executable: null, args: [] } },
      });
    });
    const hint = document.querySelector('[data-slot="editor-system-hint"]');
    expect(hint?.textContent).toContain('only for harmless types (txt, md, markdown, json, log, csv, png');
    expect(document.querySelector('[data-slot="editor-form"]')).toBeNull();
  });

  it('an own path for Notepad++ is saved with "Save editor"', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    const save = screen.getByRole('button', { name: 'Save editor' });
    expect(save.hasAttribute('disabled')).toBe(true);
    const path = screen.getByRole('textbox', { name: 'Own path (optional)' });
    await user.click(path);
    await user.paste('code');
    expect(await screen.findByText(/Enter a full local path/)).toBeTruthy();
    expect(path.getAttribute('aria-invalid')).toBe('true');
    await user.clear(path);
    await user.paste('D:\\Apps\\Notepad++\\notepad++.exe');
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    await user.click(save);
    await waitFor(() => {
      expect(updates(scenario)).toEqual([
        {
          name: 'settings.update',
          patch: { editor: { preset: 'notepadpp', executable: 'D:\\Apps\\Notepad++\\notepad++.exe', args: [] } },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByText('Not saved yet')).toBeNull();
    });
  });

  it('own program: nothing is sent until path and arguments pass the check', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.click(radio(/^Own program/));
    expect(updates(scenario)).toEqual([]);
    const path = screen.getByRole('textbox', { name: 'Program (.exe)' });
    const args = screen.getByRole('textbox', { name: 'Arguments' });

    // Save with empty fields: the issues appear at the fields, the focus goes to the first.
    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    expect(screen.getByText('Enter the path of the program.')).toBeTruthy();
    expect(screen.getByText('One argument must contain {file}.')).toBeTruthy();
    expect(document.activeElement).toBe(path);
    expect(updates(scenario)).toEqual([]);

    const issueOf = () => document.querySelector('[data-slot="editor-issue"]')?.getAttribute('data-issue');
    await user.paste('C:\\Tools\\editor.bat');
    expect(issueOf()).toBe('not_exe');
    await user.clear(path);
    await user.paste('C:\\Windows\\System32\\cmd.exe');
    expect(issueOf()).toBe('blocked');
    expect(path.getAttribute('aria-describedby')).toContain(
      document.querySelector('[data-slot="editor-issue"]')?.id ?? 'missing',
    );
    await user.clear(path);
    await user.paste('C:\\Program Files\\Sublime Text\\sublime_text.exe');
    await user.click(args);
    await user.paste('--wait\n{line}');
    expect(screen.getByText('One argument must contain {file}.')).toBeTruthy();
    await user.clear(args);
    await user.paste('{file}:{line}:{col}\n--wait\n');
    expect(document.querySelector('[data-slot="editor-issue"]')).toBeNull();
    expect(document.querySelector('[data-slot="editor-preview"]')?.textContent).toBe(
      '"C:\\Program Files\\Sublime Text\\sublime_text.exe" D:\\work\\project\\src\\app.ts:42:7 --wait',
    );

    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    await waitFor(() => {
      expect(updates(scenario)).toEqual([
        {
          name: 'settings.update',
          patch: {
            editor: {
              preset: 'custom',
              executable: 'C:\\Program Files\\Sublime Text\\sublime_text.exe',
              args: ['{file}:{line}:{col}', '--wait'],
            },
          },
        },
      ]);
    });
    // The new saved editor is detected again: the custom program exists.
    expect(await screen.findByText('The program exists.')).toBeTruthy();
  });

  it('too many arguments are refused at the field', async () => {
    const scenario = await start();
    const user = userEvent.setup();
    await user.click(radio(/^Own program/));
    await user.click(screen.getByRole('textbox', { name: 'Program (.exe)' }));
    await user.paste('C:\\Tools\\ed.exe');
    await user.click(screen.getByRole('textbox', { name: 'Arguments' }));
    await user.paste(Array.from({ length: 21 }, () => '{file}').join('\n'));
    expect(screen.getByText('At most 20 arguments.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save editor' }));
    expect(updates(scenario)).toEqual([]);
  });

  it('a stored own program shows its form; switching away and back keeps what was typed', async () => {
    const stored: EditorSettings = { preset: 'custom', executable: 'C:\\Tools\\ed.exe', args: ['-g', '{file}'] };
    const scenario = await start(stored);
    const user = userEvent.setup();
    expect(radio(/^Own program/).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Program (.exe)' }).value).toBe('C:\\Tools\\ed.exe');
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Arguments' }).value).toBe('-g\n{file}');
    await user.click(radio(/^Notepad\+\+/));
    await waitFor(() => {
      expect(updates(scenario).at(-1)).toEqual({
        name: 'settings.update',
        patch: { editor: { preset: 'notepadpp', executable: null, args: [] } },
      });
    });
    await user.click(radio(/^Own program/));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Program (.exe)' }).value).toBe('C:\\Tools\\ed.exe');
    expect(screen.getByText('Not saved yet')).toBeTruthy();
  });

  it('a failed detection says so instead of "not found"', async () => {
    await start(undefined, (scenario) => {
      scenario.host.failNext('editor.detect', makeError('OPEN_FAILED'));
    });
    expect(screen.getAllByText('Looking for the program…')).toHaveLength(2);
    expect(await screen.findAllByText('Could not check which editors are installed.')).toHaveLength(2);
  });
});
