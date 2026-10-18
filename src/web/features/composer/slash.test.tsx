import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { SlashCommandInfo } from '@shared/model';
import { registerShellRequestHandler, type ShellRequestKind } from '@web/shell/requests';
import { clientStore, resetClientStore } from '@web/state/store';
import { DecisionBar } from '../decisions/DecisionBar';
import { DEMO_ENTRIES, type DemoEntry } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { resetDecisionBarState } from '../decisions/state/bar-store';
import { Composer } from './Composer';
import { resetAttachments } from './state/attachments';
import { resetDraftStore } from './state/drafts';

// UI tests with many key strokes (docs/wp/FLAKES.md): keep a margin under parallel load.
vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;
const removers: (() => void)[] = [];

afterEach(() => {
  harness?.stop();
  harness = null;
  for (const remove of removers.splice(0)) remove();
  resetClientStore();
  resetDecisionBarState();
  resetDraftStore();
  resetAttachments();
  localStorage.clear();
});

/** `supportedCommands()` of the session (F.12 shape). */
const COMMANDS: SlashCommandInfo[] = [
  {
    name: 'clear',
    description: 'Clear conversation history and free up context',
    argumentHint: '[name]',
    aliases: ['reset', 'new'],
    builtin: true,
  },
  {
    name: 'compact',
    description: 'Clear conversation history but keep a summary in context',
    argumentHint: '<optional custom summarization instructions>',
    aliases: [],
    builtin: true,
  },
  {
    name: 'review-pr',
    description: 'Review a pull request',
    argumentHint: '<number>',
    aliases: [],
    builtin: false,
  },
  {
    name: 'vim',
    description: 'Toggle between Vim and Normal editing modes',
    argumentHint: '',
    aliases: [],
    builtin: true,
  },
  {
    name: 'model',
    description: 'Set the AI model for Claude Code',
    argumentHint: '[model]',
    aliases: [],
    builtin: true,
  },
];

type OnCommand = Parameters<typeof renderWithHost>[1]['onCommand'];

async function start(
  entry: DemoEntry = 'idle',
  options: { onCommand?: OnCommand; catalog?: boolean; bar?: boolean } = {},
): Promise<Harness> {
  const h = renderWithHost(
    (key) => (
      <>
        {options.bar === true ? <DecisionBar sessionKey={key(entry)} /> : null}
        <Composer sessionKey={key(entry)} />
      </>
    ),
    { entries: [entry], onCommand: options.onCommand },
  );
  harness = h;
  // The detail (models, init) has arrived once the model picker shows the model's display name.
  await screen.findByRole('button', { name: 'Model: Haiku' });
  if (options.catalog !== false) {
    act(() => {
      h.host.pushOps(DEMO_ENTRIES[entry], [{ op: 'detail.patch', patch: { commands: COMMANDS } }]);
    });
  }
  return h;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

function menuNames(): string[] {
  const list = screen.getByRole('listbox', { name: 'Commands' });
  return within(list)
    .getAllByRole('option')
    .map((option) => option.querySelector('[data-command]')?.getAttribute('data-command') ?? '');
}

function activeName(): string | null {
  const list = screen.getByRole('listbox', { name: 'Commands' });
  return (
    within(list)
      .getAllByRole('option')
      .find((option) => option.getAttribute('aria-selected') === 'true')
      ?.querySelector('[data-command]')
      ?.getAttribute('data-command') ?? null
  );
}

function handle(kind: ShellRequestKind) {
  const seen: string[] = [];
  removers.push(
    registerShellRequestHandler(kind, (request) => {
      seen.push('sessionKey' in request ? request.sessionKey : kind);
      return true;
    }),
  );
  return seen;
}

const ok = (result: unknown = {}) => ({ ok: true as const, result });

describe('slash menu (WP-37 §1)', () => {
  it('opens on "/" in the first word: native commands first, terminal-only ones hidden', async () => {
    await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/');
    const names = menuNames();
    expect(names.slice(0, 8)).toEqual([
      'model',
      'effort',
      'fast',
      'plan',
      'rename',
      'status',
      'help',
      'resume',
    ]);
    expect(names).toEqual(expect.arrayContaining(['clear', 'compact', 'review-pr']));
    expect(names).not.toContain('vim');
    // The catalog's `model` is the native one (once, marked Parallax).
    expect(names.filter((name) => name === 'model')).toHaveLength(1);
    const listbox = screen.getByRole('listbox', { name: 'Commands' });
    expect(within(listbox).getAllByText('Parallax')).toHaveLength(8);
    expect(within(listbox).getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(within(listbox).getByText('Skill/command')).toBeTruthy();
    expect(textbox().getAttribute('aria-controls')).toBe(listbox.id);
    expect(textbox().getAttribute('aria-activedescendant')).toBe(`${listbox.id}-option-0`);
  });

  it('filters fuzzily over name, aliases and description; Esc closes, typing reopens', async () => {
    await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/rese');
    expect(menuNames()[0]).toBe('clear');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textbox().value).toBe('/rese');
    await user.type(textbox(), 't');
    expect(menuNames()[0]).toBe('clear');
    await user.clear(textbox());
    await user.type(textbox(), '/pull request');
    // The space ends the command word: no menu.
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.clear(textbox());
    await user.type(textbox(), '/pr');
    expect(menuNames()).toContain('review-pr');
  });

  it('without a catalog it lists the names of init.slashCommands', async () => {
    await start('idle', { catalog: false });
    const user = userEvent.setup();
    await user.type(textbox(), '/comp');
    expect(menuNames()[0]).toBe('compact');
    expect(menuNames()).not.toContain('review-pr');
    // Only a name: no description, no origin badge.
    const option = screen.getAllByRole('option')[0];
    expect(option?.textContent).toBe('/compact');
  });

  it('keyboard: arrows move, Tab takes the command with its argument hint, Enter sends after it', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/c');
    const first = activeName();
    await user.keyboard('{ArrowDown}');
    expect(activeName()).not.toBe(first);
    await user.keyboard('{ArrowUp}');
    expect(activeName()).toBe(first);
    await user.clear(textbox());
    await user.type(textbox(), '/compa');
    expect(activeName()).toBe('compact');
    await user.keyboard('{Tab}');
    expect(textbox().value).toBe('/compact ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.querySelector('[data-slot="argument-hint"]')?.textContent).toContain(
      '<optional custom summarization instructions>',
    );
    await user.type(textbox(), 'keep the API notes{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual([
      '/compact keep the API notes',
    ]);
  });

  it('Enter on a native command without argument runs it right away; a click takes an entry too', async () => {
    await start();
    const seen = handle('sessionInfo');
    const user = userEvent.setup();
    await user.type(textbox(), '/stat');
    expect(activeName()).toBe('status');
    await user.keyboard('{Enter}');
    expect(seen).toHaveLength(1);
    await waitFor(() => {
      expect(textbox().value).toBe('');
    });
    await user.type(textbox(), '/ren');
    const option = screen.getByRole('option', { name: /\/rename/ });
    await user.click(option);
    expect(textbox().value).toBe('/rename ');
  });

  it('no menu while an open decision is the Enter target (ADR-040): the text answers it', async () => {
    const h = await start('permission', { bar: true });
    const user = userEvent.setup();
    await user.type(textbox(), '/model opus');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{Enter}');
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: '/model opus', interrupt: false } },
    ]);
    expect(h.commands('session.setModel')).toEqual([]);
  });
});

describe('sending a "/" draft (WP-37 §2)', () => {
  it('/model: without a name the picker opens (focus back afterwards), with a name setModel, invalid inline', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/model {Enter}');
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitemradio', { name: /^Sonnet/ })).toBeTruthy();
    expect(textbox().value).toBe('');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(document.activeElement).toBe(textbox());
    });
    await user.type(textbox(), '/model sonnet{Enter}');
    await user.type(textbox(), '/model default{Enter}');
    expect(h.commands('session.setModel').map((cmd) => cmd.model)).toEqual(['sonnet', null]);
    await user.type(textbox(), '/model -rf x{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('“-rf x” is not a valid model name.');
    expect(textbox().value).toBe('/model -rf x');
    expect(h.commands('session.setModel')).toHaveLength(2);
  });

  it('/effort: without a level the effort menu, with a level setEffort, unknown levels inline', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/effort {Enter}');
    const menu = await screen.findByRole('menu');
    expect(menu.getAttribute('data-section')).toBe('effort');
    expect(within(menu).queryByRole('menuitemradio', { name: /^Sonnet/ })).toBeNull();
    await user.click(within(menu).getByRole('menuitemradio', { name: 'High' }));
    await user.type(textbox(), '/effort low{Enter}');
    await user.type(textbox(), '/effort auto{Enter}');
    expect(h.commands('session.setEffort').map((cmd) => cmd.effort)).toEqual(['high', 'low', null]);
    await user.type(textbox(), '/effort turbo{Enter}');
    expect(screen.getByRole('alert').textContent).toBe(
      'Unknown effort “turbo” – use one of low, medium, high, xhigh, max.',
    );
  });

  it('/fast: only for models with fast mode; toggles without argument, sets with on/off', async () => {
    const h = await start('idle', {
      onCommand: (cmd, host) => {
        if (cmd.name !== 'session.setFastMode') return undefined;
        host.patchSummary(cmd.entryId, { fastMode: cmd.enabled });
        return ok();
      },
    });
    const user = userEvent.setup();
    await user.type(textbox(), '/fast {Enter}');
    expect(screen.getByRole('alert').textContent).toBe('Fast mode is not available for the current model.');
    expect(h.commands('session.setFastMode')).toEqual([]);
    act(() => {
      h.host.patchSummary(DEMO_ENTRIES.idle, { modelSetting: 'opus' });
    });
    await user.clear(textbox());
    await user.type(textbox(), '/fast {Enter}');
    await waitFor(() => {
      expect(h.commands('session.setFastMode').map((cmd) => cmd.enabled)).toEqual([true]);
    });
    await waitFor(() => {
      expect(textbox().value).toBe('');
    });
    await user.type(textbox(), '/fast {Enter}');
    await user.type(textbox(), '/fast on{Enter}');
    await user.type(textbox(), '/fast maybe{Enter}');
    expect(h.commands('session.setFastMode').map((cmd) => cmd.enabled)).toEqual([true, false, true]);
    expect(screen.getByRole('alert').textContent).toBe('Use /fast on or /fast off.');
  });

  it('/plan switches to plan mode; a text after it is sent', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/plan {Enter}');
    expect(h.commands('session.setPermissionMode').map((cmd) => cmd.mode)).toEqual(['plan']);
    await screen.findByRole('button', { name: 'Permission mode: Plan' });
    await user.type(textbox(), '/plan write the tests first{Enter}');
    await waitFor(() => {
      expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual([
        'write the tests first',
      ]);
    });
    // Already in plan mode: no second mode switch.
    expect(h.commands('session.setPermissionMode')).toHaveLength(1);
  });

  it('/rename: with a name session.rename, without the inline title edit (renameTitle)', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/rename Better title{Enter}');
    expect(h.commands('session.rename')).toEqual([
      { name: 'session.rename', entryId: DEMO_ENTRIES.idle, title: 'Better title' },
    ]);
    await user.type(textbox(), '/rename {Enter}');
    expect(screen.getByRole('alert').textContent).toBe('/rename is not available here.');
    const seen = handle('renameTitle');
    await user.clear(textbox());
    await user.type(textbox(), '/rename {Enter}');
    expect(seen).toEqual([h.key('idle')]);
    expect(textbox().value).toBe('');
  });

  it('/status and /resume ask the shell (sessionInfo, conversations)', async () => {
    const h = await start();
    const info = handle('sessionInfo');
    const conversations = handle('conversations');
    const user = userEvent.setup();
    await user.type(textbox(), '/status {Enter}');
    await user.type(textbox(), '/resume {Enter}');
    expect(info).toEqual([h.key('idle')]);
    expect(conversations).toEqual([h.key('idle')]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });

  it('/help lists the commands by origin with aliases and links the shortcuts', async () => {
    await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/help {Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Commands' });
    for (const heading of ['Parallax', 'Claude Code', 'Skills and own commands']) {
      expect(within(dialog).getByRole('heading', { name: heading })).toBeTruthy();
    }
    expect(within(dialog).getByText('also /reset, /new')).toBeTruthy();
    expect(within(dialog).getByText(/Only in the terminal: .*\/vim/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /Keyboard shortcuts/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Commands' })).toBeNull();
    });
  });

  it('/clear and its aliases go through as a prompt (the engine resets in the same entry)', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/clear {Enter}');
    await user.type(textbox(), '/new {Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual(['/clear', '/clear']);
  });

  it('terminal commands are not sent: hint with "Open in external console"', async () => {
    let fail = false;
    const h = await start('idle', {
      onCommand: (cmd) => {
        if (cmd.name !== 'session.openExternal') return undefined;
        return fail
          ? { ok: false, error: makeError('EXTERNAL_CONSOLE_FAILED', { reason: 'spawn' }) }
          : ok({ pid: 4242 });
      },
    });
    const user = userEvent.setup();
    fail = true;
    await user.type(textbox(), '/vim {Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    const hint = screen
      .getByText('/vim only works in the terminal of Claude Code')
      .closest('[data-slot="terminal-hint"]');
    if (!(hint instanceof HTMLElement)) throw new Error('no terminal hint');
    await user.click(within(hint).getByRole('button', { name: 'Open in external console' }));
    await waitFor(() => {
      expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
        { error: makeError('EXTERNAL_CONSOLE_FAILED', { reason: 'spawn' }) },
      ]);
    });
    expect(textbox().value).toBe('/vim ');
    fail = false;
    await user.click(within(hint).getByRole('button', { name: 'Open in external console' }));
    await waitFor(() => {
      expect(document.querySelector('[data-slot="terminal-hint"]')).toBeNull();
    });
    expect(h.commands('session.openExternal')).toHaveLength(2);
    expect(textbox().value).toBe('');
    await user.type(textbox(), '/config {Enter}');
    expect(screen.getByText('/config only works in the terminal of Claude Code')).toBeTruthy();
    await user.clear(textbox());
    await user.type(textbox(), '/config theme=dark{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual(['/config theme=dark']);
  });

  it('everything else goes to Claude Code as a prompt (queued while Claude works)', async () => {
    const h = await start('working');
    const user = userEvent.setup();
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
    await user.type(textbox(), '/review-pr 42');
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
    await user.keyboard('{Enter}');
    await user.type(textbox(), '/status');
    // A native command reads "Run" instead of "Queue".
    expect(screen.getByRole('button', { name: 'Run' })).toBeTruthy();
    expect(h.commands('session.sendPrompt').map((cmd) => [cmd.prompt.text, cmd.priority])).toEqual([
      ['/review-pr 42', 'next'],
    ]);
  });
});
