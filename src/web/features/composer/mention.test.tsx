import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { Command } from '@shared/protocol';
import type { FakeAck } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
import { resetDraftStore } from './state/drafts';

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDraftStore();
  localStorage.clear();
});

const FILES = [
  'README.md',
  'docs/Meeting Notes/Review.md',
  'src/web/features/composer/Composer.tsx',
  'src/web/features/composer/lib/mentions.ts',
];

type Answer = (cmd: Command) => FakeAck | undefined;

function projectFiles(files: readonly string[], truncated = false): Answer {
  return (cmd) =>
    cmd.name === 'files.project'
      ? { ok: true, result: { root: 'D:\\work\\parallax', files: [...files], truncated, source: 'git' } }
      : undefined;
}

function start(answer: Answer, entry: 'idle' | 'permission' = 'idle'): Harness {
  harness = renderWithHost((key) => <Composer sessionKey={key(entry)} />, {
    entries: [entry],
    onCommand: (cmd) => answer(cmd),
  });
  return harness;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

function picker(): HTMLElement | null {
  return screen.queryByRole('listbox', { name: 'Project files' });
}

async function options(): Promise<string[]> {
  const list = await waitFor(() => {
    const found = picker();
    if (found === null) throw new Error('no picker');
    return found;
  });
  return within(list)
    .queryAllByRole('option')
    .map((option) => option.querySelector('[data-path]')?.getAttribute('data-path') ?? '');
}

describe('@ file picker (ADR-151, WP-57)', () => {
  it('opens only at a word start – not in an e-mail address or inline code', async () => {
    const h = start(projectFiles(FILES));
    const user = userEvent.setup();
    await user.type(textbox(), 'mail alex@example');
    expect(picker()).toBeNull();
    await user.type(textbox(), ' `npm @types');
    expect(picker()).toBeNull();
    expect(h.commands('files.project')).toEqual([]);
    await user.type(textbox(), '` see @');
    expect(await options()).toEqual(FILES);
    await user.keyboard('comp');
    await waitFor(async () => {
      expect((await options())[0]).toBe('src/web/features/composer/Composer.tsx');
    });
    // Asked once per opening, not per key stroke.
    expect(h.commands('files.project')).toHaveLength(1);
  });

  it('keys: arrows move the active row (aria-activedescendant), Enter inserts "@path ", Esc closes', async () => {
    start(projectFiles(FILES));
    const user = userEvent.setup();
    await user.type(textbox(), 'look at @');
    await options();
    const field = textbox();
    expect(field.getAttribute('aria-controls')).toBe(picker()?.id);
    const first = field.getAttribute('aria-activedescendant');
    await user.keyboard('{ArrowDown}');
    const second = field.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    expect(document.getElementById(second ?? '')?.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect(textbox().value).toBe('look at @"docs/Meeting Notes/Review.md" ');
    expect(picker()).toBeNull();
    await user.keyboard('and @read');
    await options();
    await user.keyboard('{Tab}');
    expect(textbox().value).toBe('look at @"docs/Meeting Notes/Review.md" and @README.md ');
    await user.keyboard('@');
    await options();
    await user.keyboard('{Escape}');
    expect(picker()).toBeNull();
    expect(textbox().value).toBe('look at @"docs/Meeting Notes/Review.md" and @README.md @');
  });

  it('a click inserts the path (nothing is sent)', async () => {
    const h = start(projectFiles(FILES));
    const user = userEvent.setup();
    await user.type(textbox(), '@mentions');
    await options();
    await user.click(screen.getByRole('option', { name: /mentions\.ts/ }));
    expect(textbox().value).toBe('@src/web/features/composer/lib/mentions.ts ');
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });

  it('a cut project list says so; no match says so', async () => {
    start(projectFiles(FILES, true));
    const user = userEvent.setup();
    await user.type(textbox(), '@');
    await options();
    expect(
      screen.getByText('Only part of the project is listed – keep typing to narrow it down.'),
    ).toBeTruthy();
    await user.keyboard('qqq');
    await waitFor(() => {
      expect(screen.getByText('No matching file.')).toBeTruthy();
    });
  });

  it('an error of files.project shows in the list', async () => {
    start((cmd) =>
      cmd.name === 'files.project' ? { ok: false, error: makeError('FOLDER_NOT_READABLE') } : undefined,
    );
    const user = userEvent.setup();
    await user.type(textbox(), '@');
    await waitFor(() => {
      expect(screen.getByText('The project files could not be loaded.')).toBeTruthy();
    });
    expect(screen.getByText('This folder cannot be read (no permission).')).toBeTruthy();
  });

  it('not while an open decision is the Enter target (target lock)', async () => {
    const h = start(projectFiles(FILES), 'permission');
    await screen.findByText(/Enter denies it with your text/);
    await userEvent.setup().type(textbox(), '@src');
    expect(picker()).toBeNull();
    expect(h.commands('files.project')).toEqual([]);
  });
});
