import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { clientStore, resetClientStore } from '@web/state/store';
import { DecisionBar } from '../decisions/DecisionBar';
import { DEMO_ENTRIES, type DemoEntry } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { resetDecisionBarState } from '../decisions/state/bar-store';
import { Composer } from './Composer';
import { draftStorageKey, resetDraftStore } from './state/drafts';

// UI tests with many key strokes: generous timeout under a fully parallel `pnpm test`.
vi.setConfig({ testTimeout: 20_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  resetDraftStore();
  localStorage.clear();
});

function start(entry: DemoEntry, onCommand?: Parameters<typeof renderWithHost>[1]['onCommand']) {
  harness = renderWithHost(
    (key) => (
      <>
        <DecisionBar sessionKey={key(entry)} />
        <Composer sessionKey={key(entry)} />
      </>
    ),
    { entries: [entry], onCommand },
  );
  return harness;
}

function textbox(): HTMLTextAreaElement {
  const element = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
  return element;
}

describe('Composer', () => {
  it('Enter sends (priority next), Shift+Enter breaks the line', async () => {
    const h = start('idle');
    const user = userEvent.setup();
    await user.type(textbox(), 'first line{Shift>}{Enter}{/Shift}second line');
    expect(textbox().value).toBe('first line\nsecond line');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    await user.keyboard('{Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([
      {
        name: 'session.sendPrompt',
        entryId: DEMO_ENTRIES.idle,
        prompt: { text: 'first line\nsecond line', attachments: [] },
        priority: 'next',
      },
    ]);
    expect(textbox().value).toBe('');
  });

  it('does not send empty text', async () => {
    const h = start('idle');
    const user = userEvent.setup();
    await user.type(textbox(), '   {Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });

  it('queues while Claude works and shows the queued messages', async () => {
    const h = start('working');
    const user = userEvent.setup();
    expect(screen.getByRole('region', { name: 'Queued messages' }).textContent).toContain(
      'Also add a sequence diagram.',
    );
    expect(screen.getByText('2 queued messages')).toBeTruthy();
    await user.type(textbox(), 'one more{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.priority)).toEqual(['next']);
    await user.type(textbox(), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(h.commands('session.sendPrompt').map((cmd) => [cmd.prompt.text, cmd.priority])).toEqual([
      ['one more', 'next'],
      ['urgent', 'now'],
    ]);
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
  });

  it('Stop interrupts the session', async () => {
    const h = start('working');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(h.commands('session.interrupt')).toEqual([
      { name: 'session.interrupt', entryId: DEMO_ENTRIES.working },
    ]);
  });

  it('Esc in the empty composer stops – not with text, not with the focus elsewhere', async () => {
    const h = renderWithHost(
      (key) => (
        <>
          <input aria-label="elsewhere" />
          <Composer sessionKey={key('working')} />
        </>
      ),
      { entries: ['working'] },
    );
    harness = h;
    const user = userEvent.setup();
    await user.click(screen.getByRole('textbox', { name: 'elsewhere' }));
    await user.keyboard('{Escape}');
    expect(h.commands('session.interrupt')).toEqual([]);
    await user.type(textbox(), 'draft');
    await user.keyboard('{Escape}');
    expect(h.commands('session.interrupt')).toEqual([]);
    await user.clear(textbox());
    await user.keyboard('{Escape}');
    expect(h.commands('session.interrupt')).toHaveLength(1);
  });

  it('keeps the draft per session across a remount (localStorage)', async () => {
    const h = start('idle');
    const user = userEvent.setup();
    await user.type(textbox(), 'half a thought');
    expect(localStorage.getItem(draftStorageKey(h.key('idle')))).toBe('half a thought');
    h.stop();
    harness = null;
    resetDraftStore();
    resetClientStore();
    start('idle');
    expect(textbox().value).toBe('half a thought');
  });

  it('reports typing (presence) on input', async () => {
    start('idle');
    const user = userEvent.setup();
    expect(clientStore.getState().presence.typing).toBe(false);
    await user.type(textbox(), 'a');
    expect(clientStore.getState().presence.typing).toBe(true);
  });

  it('restores the text and shows a notice when sending fails', async () => {
    start('idle', (cmd) =>
      cmd.name === 'session.sendPrompt' ? { ok: false, error: makeError('SESSION_BUSY') } : undefined,
    );
    const user = userEvent.setup();
    await user.type(textbox(), 'try this{Enter}');
    await waitFor(() => {
      expect(textbox().value).toBe('try this');
    });
    expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
      { error: makeError('SESSION_BUSY') },
    ]);
  });

  it('cannot send while the host is not connected', async () => {
    const h = start('idle');
    const user = userEvent.setup();
    act(() => {
      h.running.connection.stop();
    });
    await user.type(textbox(), 'offline{Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    expect(screen.getByText('Not connected')).toBeTruthy();
  });
});

describe('Composer with an open decision (Plan: text = "No, instead: …")', () => {
  it('permission: "Send as answer" denies with the text', async () => {
    const h = start('permission');
    const user = userEvent.setup();
    expect(screen.getByText(/Answering the Bash permission \(Main agent\)/)).toBeTruthy();
    await user.type(textbox(), 'Use pnpm i{Enter}');
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'Use pnpm i', interrupt: false } },
    ]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });

  it('question: the text declines with a message', async () => {
    const h = start('question');
    const user = userEvent.setup();
    await user.type(textbox(), 'Use YAML');
    await user.click(screen.getByRole('button', { name: 'Send as answer' }));
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      { kind: 'question', response: { behavior: 'decline', message: 'Use YAML' } },
    ]);
  });

  it('plan: the send button reads "Keep planning with feedback" and revises', async () => {
    const h = start('plan');
    const user = userEvent.setup();
    await user.type(textbox(), 'Split step 2');
    const buttons = screen.getAllByRole('button', { name: 'Keep planning with feedback' });
    const fromComposer = buttons.at(-1);
    if (fromComposer === undefined) throw new Error('missing');
    await user.click(fromComposer);
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      { kind: 'plan', response: { behavior: 'revise', feedback: 'Split step 2' } },
    ]);
  });

  it('"Send as new message instead" queues a normal prompt and leaves the decision open', async () => {
    const h = start('permission');
    const user = userEvent.setup();
    await user.type(textbox(), 'after that, run lint');
    await user.click(screen.getByRole('button', { name: 'More send options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Send as new message instead' }));
    expect(h.commands('decision.respond')).toEqual([]);
    expect(h.commands('session.sendPrompt').map((cmd) => [cmd.prompt.text, cmd.priority])).toEqual([
      ['after that, run lint', 'next'],
    ]);
    expect(document.querySelector('[data-decision-id]')).not.toBeNull();
  });
});
