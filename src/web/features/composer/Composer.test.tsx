import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Decision } from '@shared/model';
import { sampleDecisions, sampleExternalHandoff, sampleId } from '@shared/samples';
import { resetHandoffs, trackHandoff } from '@web/shell/navigation/handoff';
import { clientStore, resetClientStore } from '@web/state/store';
import { DecisionBar } from '../decisions/DecisionBar';
import { DEMO_ENTRIES, type DemoEntry } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { resetDecisionBarState } from '../decisions/state/bar-store';
import { Composer } from './Composer';
import { draftStorageKey, resetDraftStore, setDraft } from './state/drafts';

// UI tests with many key strokes: 2.5–6 s in a full `pnpm test`, up to 21 s when several runs load
// the machine (docs/wp/FLAKES.md). A timed-out test keeps typing into the next one, so keep a margin.
vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  resetDraftStore();
  resetHandoffs();
  localStorage.clear();
});

/**
 * Chromium/Edge: a textarea React creates with text keeps its caret at the start (React sets the
 * default value and then the same value – no change, so the caret does not move). happy-dom moves it
 * to the end. Until the returned restore runs, a value set on a field not yet in the document puts
 * the caret at its start, as in the browser (WP41-07).
 */
function emulateChromiumNewFieldCaret(): () => void {
  let prototype: object | null = HTMLTextAreaElement.prototype;
  let owner: object | null = null;
  let original: PropertyDescriptor | undefined;
  while (prototype !== null && original === undefined) {
    original = Object.getOwnPropertyDescriptor(prototype, 'value');
    owner = prototype;
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  if (original?.set === undefined || owner === null) {
    throw new Error('textarea without a value accessor');
  }
  const descriptor = original;
  const target = owner;
  Object.defineProperty(target, 'value', {
    ...descriptor,
    set(this: HTMLTextAreaElement, value: string) {
      descriptor.set?.call(this, value);
      if (!this.isConnected) this.setSelectionRange(0, 0);
    },
  });
  return () => {
    Object.defineProperty(target, 'value', descriptor);
  };
}

function start(
  entry: DemoEntry,
  options: { onCommand?: Parameters<typeof renderWithHost>[1]['onCommand']; armDelayMs?: number } = {},
) {
  harness = renderWithHost(
    (key) => (
      <>
        <DecisionBar sessionKey={key(entry)} />
        <Composer sessionKey={key(entry)} />
      </>
    ),
    { entries: [entry], onCommand: options.onCommand, armDelayMs: options.armDelayMs },
  );
  return harness;
}

function textbox(): HTMLTextAreaElement {
  const element = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
  return element;
}

/** The server opens a decision (e.g. while the user types). */
function openDecision(h: Harness, entry: DemoEntry, decision: Decision) {
  act(() => {
    h.host.pushOps(DEMO_ENTRIES[entry], [{ op: 'decision.upsert', decision }]);
  });
}

function latePermission(entry: DemoEntry, p: Partial<Parameters<typeof sampleDecisions.permission>[0]> = {}) {
  return sampleDecisions.permission({
    entryId: DEMO_ENTRIES[entry],
    id: sampleId('dc', 0xc01),
    toolUseId: 'toolu_late_bash',
    ...p,
  });
}

function responses(h: Harness) {
  return h.commands('decision.respond').map((cmd) => cmd.response);
}

function prompts(h: Harness) {
  return h.commands('session.sendPrompt').map((cmd) => [cmd.prompt.text, cmd.priority]);
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

  it('queues while Claude works – the queue itself is shown by transcript and header, not here (R2W-04)', async () => {
    const h = start('working');
    const user = userEvent.setup();
    expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull();
    expect(screen.queryByText('Also add a sequence diagram.')).toBeNull();
    await user.type(textbox(), 'one more{Enter}');
    expect(h.commands('session.sendPrompt').map((cmd) => cmd.priority)).toEqual(['next']);
    await user.type(textbox(), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Send now' }));
    expect(prompts(h)).toEqual([
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
    start('idle', {
      onCommand: (cmd) =>
        cmd.name === 'session.sendPrompt' ? { ok: false, error: makeError('SESSION_BUSY') } : undefined,
    });
    const user = userEvent.setup();
    await user.type(textbox(), 'try this{Enter}');
    await waitFor(() => {
      expect(textbox().value).toBe('try this');
    });
    // WP41-07: the caret stands at the end of the text that came back.
    expect([textbox().selectionStart, textbox().selectionEnd]).toEqual([8, 8]);
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

  it('shows a character counter near the contract limit and blocks above it (R2W-12)', () => {
    const h = start('idle');
    expect(document.querySelector('[data-slot="composer-counter"]')).toBeNull();
    act(() => {
      setDraft(h.key('idle'), 'x'.repeat(170_000));
    });
    expect(screen.getByText('170,000 / 200,000 characters')).toBeTruthy();
    act(() => {
      setDraft(h.key('idle'), 'x'.repeat(200_001));
    });
    expect(screen.getByRole('alert').textContent).toBe('Too long – at most 200,000 characters.');
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('Composer and the handoff to an external console (WP41-07)', () => {
  it('while "Open in external console" is on its way nothing is sent – Enter and the button do nothing, the text stays', async () => {
    const h = start('idle');
    const user = userEvent.setup();
    await user.type(textbox(), 'second writer');
    let answer: () => void = () => undefined;
    let request: Promise<void> = Promise.resolve();
    act(() => {
      // As from the session menu: the composer only sees the shared state.
      request = trackHandoff(
        h.key('idle'),
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
      );
    });
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await user.keyboard('{Enter}');
    expect(h.commands('session.sendPrompt')).toEqual([]);
    expect(textbox().value).toBe('second writer');
    // Refused (or the console did not open): writing here goes on.
    await act(async () => {
      answer();
      await request;
    });
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false);
    await user.keyboard('{Enter}');
    expect(prompts(h)).toEqual([['second writer', 'next']]);
  });

  it('a prompt refused because the session went to a console comes back with the caret at its end – in the field after the return', async () => {
    const h = start('idle', {
      onCommand: (cmd, host) => {
        if (cmd.name !== 'session.sendPrompt') return undefined;
        // Another window handed the session off a moment earlier (R4-01: the server refuses).
        host.patchSummary(cmd.entryId, {
          external: { since: sampleExternalHandoff().since, pid: 52_000, running: true },
        });
        return { ok: false, error: makeError('SESSION_EXTERNAL') };
      },
    });
    const user = userEvent.setup();
    await user.type(textbox(), 'Only the word.{Enter}');
    await waitFor(() => {
      expect(document.querySelector('[data-slot="composer"]')?.getAttribute('data-reason')).toBe('external');
    });
    await waitFor(() => {
      expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
        { error: makeError('SESSION_EXTERNAL') },
      ]);
    });
    // Back from the console: a new field with the refused text, the caret at its end.
    const restore = emulateChromiumNewFieldCaret();
    try {
      act(() => {
        h.host.patchSummary(DEMO_ENTRIES.idle, { external: null });
      });
    } finally {
      restore();
    }
    expect(textbox().value).toBe('Only the word.');
    expect([textbox().selectionStart, textbox().selectionEnd]).toEqual([14, 14]);
    // New text goes after the old one (live it landed in front of it).
    act(() => {
      textbox().focus();
    });
    await user.keyboard(' Second writer');
    expect(textbox().value).toBe('Only the word. Second writer');
  });
});

describe('Composer with an open decision (Plan: text = "No, instead: …")', () => {
  it('permission: Enter denies with the text', async () => {
    const h = start('permission');
    const user = userEvent.setup();
    expect(screen.getByText(/Answering the Bash permission \(Main agent\)/)).toBeTruthy();
    await user.type(textbox(), 'Use pnpm i{Enter}');
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'Use pnpm i', interrupt: false } },
    ]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });

  it('several questions: the text skips them with a message', async () => {
    const h = start('question');
    const user = userEvent.setup();
    await user.type(textbox(), 'Use YAML');
    expect(screen.getByText(/Enter skips them with your text/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send as answer' }));
    expect(responses(h)).toEqual([
      { kind: 'question', response: { behavior: 'decline', message: 'Use YAML' } },
    ]);
  });

  it('one question: the text is the answer ("Other"), not a skip (R2W-13)', async () => {
    const h = start('idle');
    const user = userEvent.setup();
    openDecision(
      h,
      'idle',
      sampleDecisions.question({
        entryId: DEMO_ENTRIES.idle,
        id: sampleId('dc', 0xc03),
        toolUseId: 'toolu_q1',
      }),
    );
    expect(textbox().placeholder).toBe('Answer in your own words…');
    await user.type(textbox(), 'Green, please{Enter}');
    expect(responses(h)).toEqual([
      {
        kind: 'question',
        response: {
          behavior: 'answer',
          answers: [
            {
              question: 'Which color should the button be?',
              selected: [],
              otherText: 'Green, please',
              notes: null,
            },
          ],
        },
      },
    ]);
  });

  it('plan: the send button reads "Keep planning with feedback" and revises', async () => {
    const h = start('plan');
    const user = userEvent.setup();
    await user.type(textbox(), 'Split step 2');
    // The bar keeps "Keep planning" (R2W-16) – "…with feedback" is the composer's button only.
    await user.click(screen.getByRole('button', { name: 'Keep planning with feedback' }));
    expect(responses(h)).toEqual([
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
    expect(prompts(h)).toEqual([['after that, run lint', 'next']]);
    expect(document.querySelector('[data-decision-id]')).not.toBeNull();
  });
});

describe('Composer target lock (R2W-01, ADR-040)', () => {
  it('a decision that appears while typing is NOT answered by Enter – the text is sent as a message', async () => {
    const h = start('working');
    const user = userEvent.setup();
    await user.type(textbox(), 'next, write the tests');
    openDecision(h, 'working', latePermission('working'));
    // The bar shows it, the composer says Enter stays a message; the focus stays in the field.
    expect(document.querySelector('[data-decision-id]')).not.toBeNull();
    expect(
      screen.getByText(/The Bash permission \(Main agent\) is open – Enter sends a new message/),
    ).toBeTruthy();
    expect(document.activeElement).toBe(textbox());
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(responses(h)).toEqual([]);
    expect(prompts(h)).toEqual([['next, write the tests', 'next']]);
    expect(document.querySelector('[data-decision-id]')).not.toBeNull();
    // A draft begun while the decision is shown answers it (the lock is fixed at the first key).
    await user.type(textbox(), 'use pnpm{Enter}');
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'use pnpm', interrupt: false } },
    ]);
  });

  it('"Send as answer" answers a decision that appeared while typing – only explicitly', async () => {
    const h = start('working');
    const user = userEvent.setup();
    await user.type(textbox(), 'use pnpm instead');
    openDecision(h, 'working', latePermission('working'));
    await user.click(screen.getByRole('button', { name: 'Send as answer' }));
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'use pnpm instead', interrupt: false } },
    ]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });

  it("Enter never answers a subagent's request (even when it was shown before typing)", async () => {
    const h = start('working');
    const user = userEvent.setup();
    openDecision(
      h,
      'working',
      latePermission('working', {
        requester: {
          kind: 'subagent',
          agentId: 'agent_explore_1',
          description: 'Explore the store code',
          parentToolUseId: 'toolu_demo_agent',
        },
      }),
    );
    await user.type(textbox(), 'keep going{Enter}');
    expect(responses(h)).toEqual([]);
    expect(prompts(h)).toEqual([['keep going', 'next']]);
    await user.type(textbox(), 'not that folder');
    await user.click(screen.getByRole('button', { name: 'Send as answer' }));
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'not that folder', interrupt: false } },
    ]);
  });

  it('a draft restored after a reload is no answer: Enter sends it as a message', async () => {
    localStorage.setItem(
      draftStorageKey(makeSessionKey(LOCAL_HOST_ID, DEMO_ENTRIES.permission)),
      'written before the reload',
    );
    const h = start('permission');
    const user = userEvent.setup();
    expect(textbox().value).toBe('written before the reload');
    await user.click(textbox());
    await user.keyboard('{Enter}');
    expect(responses(h)).toEqual([]);
    expect(prompts(h)).toEqual([['written before the reload', 'next']]);
  });

  it('a decision shown less than the arm delay before the first key stroke is not the target', async () => {
    const h = start('permission', { armDelayMs: 60_000 });
    const user = userEvent.setup();
    await user.type(textbox(), 'just a message{Enter}');
    expect(responses(h)).toEqual([]);
    expect(prompts(h)).toEqual([['just a message', 'next']]);
  });

  it('"Keep planning" in the bar makes the plan the target of the draft', async () => {
    const h = start('plan', { armDelayMs: 60_000 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Keep planning' }));
    expect(document.activeElement).toBe(textbox());
    await user.type(textbox(), 'more tests first{Enter}');
    expect(responses(h)).toEqual([
      { kind: 'plan', response: { behavior: 'revise', feedback: 'more tests first' } },
    ]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });
});
