import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import { clientStore, resetClientStore } from '@web/state/store';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
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
  it('from 2 000 characters on a paste becomes a token + chip; 1 999 stay text', () => {
    start();
    expect(pasteText('x'.repeat(1999))).toBe(true);
    expect(pasteChips()).toEqual([]);
    expect(pasteText('y'.repeat(2000))).toBe(false);
    expect(textbox().value).toBe('[#1 · 1 line]');
    expect(pasteChips()).toHaveLength(1);
    expect(screen.getByText('Pasted text #1 · 1 line')).toBeTruthy();
  });

  it('… or from 30 lines on; 29 lines stay text', () => {
    start();
    expect(pasteText(lines(29))).toBe(true);
    expect(pasteChips()).toEqual([]);
    expect(pasteText(lines(30))).toBe(false);
    expect(textbox().value).toBe('[#1 · 30 lines]');
    expect(screen.getByText('Pasted text #1 · 30 lines')).toBeTruthy();
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
    await user.keyboard('{Enter}');
    const normalizedTrace = `${'z'.repeat(2100)}\nend`;
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.prompt)).toEqual([
      {
        text: `Check this: ${log} and ${normalizedTrace} thanks`,
        attachments: [],
        pastes: [log, normalizedTrace],
      },
    ]);
    expect(pasteChips()).toEqual([]);
  });

  it('a deleted token drops its paste: no chip and nothing in pastes', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.type(textbox(), 'a ');
    pasteText(lines(35));
    expect(pasteChips()).toHaveLength(1);
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
    await user.click(screen.getByText('Pasted text #1 · 31 lines'));
    expect(document.querySelector('[data-slot="paste-preview"]')?.textContent).toBe(text);
    await user.click(screen.getByRole('button', { name: 'Convert pasted text #1 to text' }));
    expect(textbox().value).toBe(text);
    expect(pasteChips()).toEqual([]);
    await user.clear(textbox());
    await user.type(textbox(), 'x ');
    pasteText(lines(32));
    expect(textbox().value).toBe('x [#1 · 32 lines]');
    await user.click(screen.getByRole('button', { name: 'Remove pasted text #1' }));
    expect(textbox().value).toBe('x ');
    expect(pasteChips()).toEqual([]);
  });

  it(`at most ${String(LIMITS.pastesMax)} chips; the next paste goes in as text with a note`, () => {
    start();
    for (let i = 0; i < LIMITS.pastesMax; i += 1) expect(pasteText(lines(30, `p${String(i)}`))).toBe(false);
    expect(pasteChips()).toHaveLength(LIMITS.pastesMax);
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
    expect(pasteChips()).toHaveLength(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(again.commands('session.sendPrompt').map((cmd) => cmd.prompt.pastes)).toEqual([[log]]);
    });
  });
});
