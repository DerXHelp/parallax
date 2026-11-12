import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { clientStore, resetClientStore } from '@web/state/store';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
import { SLASH_GUARD } from './lib/pastes';
import { pastesStorageKey, resetDraftStore } from './state/drafts';

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDraftStore();
  localStorage.clear();
});

function start(): Harness {
  harness = renderWithHost((key) => <Composer sessionKey={key('idle')} />, { entries: ['idle'] });
  return harness;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

function pasteChips(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Pasted texts' });
  return list === null ? [] : within(list).getAllByRole('listitem');
}

/** The chips are a lazy chunk (R5W-01): wait until `count` of them show. */
async function expectChips(count: number): Promise<void> {
  await waitFor(() => {
    expect(pasteChips()).toHaveLength(count);
  });
}

/** Pastes plain text; true when the browser would insert it itself (default not prevented). */
function pasteText(text: string): boolean {
  return fireEvent.paste(textbox(), {
    clipboardData: {
      items: [],
      files: [],
      types: ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}`).join('\n');
}

describe('paste chips (ADR-146, WP-57)', () => {
  it('from 2 000 characters on a paste becomes a token + chip; 1 999 stay text', async () => {
    start();
    expect(pasteText('x'.repeat(1999))).toBe(true);
    expect(pasteText('y'.repeat(2000))).toBe(false);
    expect(textbox().value).toBe('[#1 · 1 line]');
    await expectChips(1);
    expect(screen.getByText('Pasted text #1 · 1 line')).toBeTruthy();
  });

  it('… or from 30 lines on; 29 lines stay text', async () => {
    start();
    expect(pasteText(lines(29))).toBe(true);
    expect(pasteText(lines(30))).toBe(false);
    expect(textbox().value).toBe('[#1 · 30 lines]');
    expect(await screen.findByText('Pasted text #1 · 30 lines')).toBeTruthy();
    await expectChips(1);
  });

  it('sending replaces the tokens; pastes lists each text exactly as it stands in the sent text', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.type(textbox(), 'Check this: ');
    const log = lines(40, 'log');
    const trace = `${'z'.repeat(2100)}\r\nend`;
    pasteText(log);
    await user.keyboard(' and ');
    pasteText(trace);
    await user.keyboard(' thanks');
    expect(textbox().value).toBe('Check this: [#1 · 40 lines] and [#2 · 2 lines] thanks');
    await expectChips(2);
    await user.keyboard('{Enter}');
    const normalizedTrace = `${'z'.repeat(2100)}\nend`;
    // V4-07: the text after a paste starts a line of its own.
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt)).toEqual([
      {
        text: `Check this: ${log}\nand ${normalizedTrace}\nthanks`,
        attachments: [],
        pastes: [log, normalizedTrace],
      },
    ]);
    await expectChips(0);
  });

  it('V4-07: a question after the paste is not glued to its last line', async () => {
    const h = start();
    const user = userEvent.setup();
    const log = lines(40, '------');
    await user.click(textbox());
    pasteText(log);
    await user.keyboard(' what is wrong?{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual([
      `${log}\nwhat is wrong?`,
    ]);
  });

  it('a deleted token drops its paste: no chip and nothing in pastes', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.type(textbox(), 'a ');
    pasteText(lines(35));
    await expectChips(1);
    await user.clear(textbox());
    await user.type(textbox(), 'only text{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt)).toEqual([
      { text: 'only text', attachments: [], pastes: [] },
    ]);
  });

  it('the chip previews the text, removes it (token gone) or converts it to plain text', async () => {
    start();
    const user = userEvent.setup();
    const text = lines(31);
    pasteText(text);
    await user.click(await screen.findByText('Pasted text #1 · 31 lines'));
    expect(document.querySelector('[data-slot="paste-preview"]')?.textContent).toBe(text);
    await user.click(screen.getByRole('button', { name: 'Convert pasted text #1 to text' }));
    expect(textbox().value).toBe(text);
    expect(pasteChips()).toEqual([]);
    await user.clear(textbox());
    await user.type(textbox(), 'x ');
    pasteText(lines(32));
    expect(textbox().value).toBe('x [#1 · 32 lines]');
    await user.click(await screen.findByRole('button', { name: 'Remove pasted text #1' }));
    expect(textbox().value).toBe('x ');
    expect(pasteChips()).toEqual([]);
  });

  it(`at most ${String(LIMITS.pastesMax)} chips; the next paste goes in as text with a note`, async () => {
    start();
    for (let i = 0; i < LIMITS.pastesMax; i += 1) expect(pasteText(lines(30, `p${String(i)}`))).toBe(false);
    await expectChips(LIMITS.pastesMax);
    expect(pasteText(lines(30, 'extra'))).toBe(true);
    expect(pasteChips()).toHaveLength(LIMITS.pastesMax);
    expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
      { text: 'composer.pastes.asTextCount', params: { max: LIMITS.pastesMax } },
    ]);
  });

  it('the draft keeps its pastes over a remount (localStorage) and still sends them', async () => {
    const h = start();
    const key = h.key('idle');
    const log = lines(45);
    pasteText(log);
    expect(JSON.parse(localStorage.getItem(pastesStorageKey(key)) ?? '[]')).toEqual([
      { id: 1, token: '[#1 · 45 lines]', text: log },
    ]);
    h.stop();
    resetDraftStore();
    const again = start();
    expect(textbox().value).toBe('[#1 · 45 lines]');
    await expectChips(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(again.commands('session.sendPrompt').map((cmd) => cmd.prompt.pastes)).toEqual([[log]]);
    });
  });
});

describe('a paste at the start never sends a slash command (R5W-03)', () => {
  it('a pasted "/clear …" goes as a prompt that does not start with "/"', async () => {
    const h = start();
    const user = userEvent.setup();
    const pasted = `/clear\n${lines(40)}`;
    await user.click(textbox());
    pasteText(pasted);
    expect(textbox().value).toBe('[#1 · 41 lines]');
    await user.keyboard(' why does this fail?{Enter}');
    const prompts = h.commands('session.sendPrompt').map((cmd) => cmd.prompt);
    expect(prompts).toEqual([
      { text: `${SLASH_GUARD}${pasted}\nwhy does this fail?`, attachments: [], pastes: [pasted] },
    ]);
    expect(prompts[0]?.text.trim().startsWith('/')).toBe(false);
    expect(document.querySelector('[data-slot="terminal-hint"]')).toBeNull();
  });

  it('neither a native nor a terminal-only command runs from a pasted text', async () => {
    const h = start();
    const user = userEvent.setup();
    const model = `/model opus\n${lines(30)}`;
    await user.click(textbox());
    pasteText(model);
    await user.keyboard('{Enter}');
    const config = `/config\n${lines(30)}`;
    pasteText(config);
    await user.keyboard('{Enter}');
    expect(h.commands('session.setModel')).toEqual([]);
    expect(document.querySelector('[data-slot="terminal-hint"]')).toBeNull();
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual([
      `${SLASH_GUARD}${model}`,
      `${SLASH_GUARD}${config}`,
    ]);
  });

  it('a typed command with a paste after it stays a command', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.type(textbox(), '/review ');
    const pasted = `/c/Users/dev/build.log\n${lines(30)}`;
    pasteText(pasted);
    await user.keyboard('{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt.text)).toEqual([`/review ${pasted}`]);
  });
});
