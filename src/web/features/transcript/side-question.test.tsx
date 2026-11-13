import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { SideQuestionItem, TranscriptItem } from '@shared/model';
import {
  sampleDetail,
  sampleId,
  sampleItems,
  sampleQueuedPrompt,
  sampleSessionSnapshot,
  sampleSummary,
  sampleTime,
} from '@shared/samples';
import { setLanguage } from '@web/i18n';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { registerShellRequestHandler } from '@web/shell/requests';
import { clientStore, resetClientStore } from '@web/state/store';
import { QueuedPromptRow } from './items/MessageRows';
import { SideQuestionCard } from './items/SideQuestionCard';
import { buildRows, itemCodesById } from './lib/grouping';
import { resetExpansion } from './state/expansion';
import { resetGroups } from './state/groups';
import { installResizeObserver, installScrollEvents, startTranscriptScenario } from './testing';
import { TranscriptView } from './TranscriptView';

/**
 * WP-66 in the transcript: the side-question card (thread at the position of its first question,
 * never inside a step group; pending with Cancel, follow-up, delete, the states of an answer) and
 * „Zurückholen“ of a waiting message (text back into the composer, "already taken over").
 */

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await import('./markdown/MarkdownRenderer');
  await import('./items/SideQuestionCard');
}, 180_000);

let running: RunningScenario | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreScrollEvents: (() => void) | null = null;
const removers: (() => void)[] = [];

beforeEach(() => {
  restoreResizeObserver = installResizeObserver({ viewport: 2000, item: 40 });
  restoreScrollEvents = installScrollEvents();
});

afterEach(() => {
  running?.stop();
  running = null;
  for (const remove of removers.splice(0)) remove();
  resetClientStore();
  resetExpansion();
  act(() => {
    resetGroups();
    setLanguage('en');
  });
  restoreResizeObserver?.();
  restoreScrollEvents?.();
});

const ENTRY = sampleId('en', 66);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);

/** A side question like the engine creates it (ids `px:<conversation>:<order>`). */
function side(p: Partial<SideQuestionItem> & { id: string; order: number }): SideQuestionItem {
  return {
    kind: 'side_question',
    at: sampleTime(p.order),
    parentToolUseId: null,
    threadId: p.id,
    question: 'What is the plan?',
    status: 'answered',
    response: 'The plan is **simple**.',
    synthetic: false,
    fallbackModel: null,
    retry: null,
    error: null,
    answeredAt: sampleTime(p.order + 1),
    ...p,
  };
}

function start(items: TranscriptItem[], queue = sampleDetail({ entryId: ENTRY }).queue): void {
  running = startTranscriptScenario([
    {
      snapshot: sampleSessionSnapshot({
        entryId: ENTRY,
        seq: 0,
        items,
        detail: sampleDetail({ entryId: ENTRY, queue }),
      }),
      summary: sampleSummary({ entryId: ENTRY }),
    },
  ]);
}

function host() {
  if (running === null) throw new Error('no scenario');
  return running.host;
}

function rowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-row]')].map((row) => row.dataset.row ?? '');
}

async function card(): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.querySelector<HTMLElement>('[data-item-kind="side_question"]');
    if (element === null) throw new Error('no side-question card');
    return element;
  });
}

describe('roles in the compact transcript (lib/grouping)', () => {
  it('a side question is visible (splits a run of steps); follow-ups hide while the first question is loaded', () => {
    const items: TranscriptItem[] = [
      sampleItems.thinking({ id: 't1', order: 1 }),
      sampleItems.toolCall({ id: 'b1', order: 2, toolUseId: 'toolu_b1' }),
      side({ id: 's1', order: 3 }),
      sampleItems.toolCall({ id: 'b2', order: 4, toolUseId: 'toolu_b2' }),
      sampleItems.thinking({ id: 't2', order: 5 }),
      side({ id: 's2', order: 6, threadId: 's1' }),
    ];
    const codes = itemCodesById(items);
    expect([...codes.values()]).toEqual(['s', 's', 'v', 's', 's', 'h']);
    const ids = items.map((item) => item.id);
    const rows = buildRows(
      ids,
      ids.map((id) => codes.get(id) ?? 'v'),
      'compact',
      () => false,
    );
    expect(rows.map((row) => (row.kind === 'item' ? row.id : row.kind))).toEqual(['group', 's1', 'group']);
    // The first question scrolled out of the loaded items: the earliest loaded follow-up is the card.
    const later = itemCodesById([
      side({ id: 's2', order: 6, threadId: 's1' }),
      side({ id: 's3', order: 8, threadId: 's1' }),
    ]);
    expect([...later.values()]).toEqual(['v', 'h']);
  });
});

describe('side-question card (WP-66 §1.2)', () => {
  it('the thread at its first question: answer as Markdown, a pending follow-up with Cancel; Delete removes it', async () => {
    start([
      sampleItems.userMessage({ id: 'u1', order: 1, text: { text: 'Fix the build.', truncated: null } }),
      side({ id: 's1', order: 2 }),
      sampleItems.assistantText({ id: 'a1', order: 3, text: 'Working on it.' }),
      side({
        id: 's2',
        order: 4,
        threadId: 's1',
        question: 'And then?',
        status: 'pending',
        response: null,
        answeredAt: null,
      }),
    ]);
    render(<TranscriptView sessionKey={KEY} />);
    const element = await card();
    expect(within(element).getByText('Side question · not in the context')).toBeTruthy();
    expect(within(element).getByText('What is the plan?')).toBeTruthy();
    await waitFor(() => {
      expect(within(element).getByText('simple').tagName).toBe('STRONG');
    });
    expect(within(element).getByText('And then?')).toBeTruthy();
    expect(within(element).getByText('asking…')).toBeTruthy();
    // One card for the thread, between the user message and the answer; never in a group.
    expect(document.querySelectorAll('[data-item-kind="side_question"]')).toHaveLength(1);
    expect(rowIds()).toEqual(['item', 'item', 'item']);
    expect(within(element).queryByRole('button', { name: 'Follow up' })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(element).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(within(element).getByText('Cancelled')).toBeTruthy();
    });
    expect(host().commands).toContainEqual({
      name: 'session.cancelSideQuestion',
      entryId: ENTRY,
      itemId: 's2',
    });

    await user.click(within(element).getByRole('button', { name: 'Delete the side question' }));
    await waitFor(() => {
      expect(document.querySelector('[data-item-kind="side_question"]')).toBeNull();
    });
    expect(host().commands).toContainEqual({
      name: 'session.deleteSideQuestion',
      entryId: ENTRY,
      threadId: 's1',
    });
    expect(screen.getByText('Working on it.')).toBeTruthy();
  });

  it('Follow up: a small field, Enter asks in the same thread; the answer joins the card', async () => {
    start([side({ id: 's1', order: 1 })]);
    render(<TranscriptView sessionKey={KEY} />);
    const element = await card();
    const user = userEvent.setup();
    await user.click(within(element).getByRole('button', { name: 'Follow up' }));
    const field = within(element).getByRole('textbox', { name: 'Follow up' });
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute('placeholder')).toBe('Follow-up – does not go into the context');
    await user.type(field, 'And the tests?{Enter}');
    expect(host().commands).toContainEqual({
      name: 'session.askSideQuestion',
      entryId: ENTRY,
      question: 'And the tests?',
      threadId: 's1',
    });
    await waitFor(() => {
      expect(within(element).getByText('And the tests?')).toBeTruthy();
    });
    expect(within(element).queryByRole('textbox')).toBeNull();
    // The playground host answers a moment later (no model).
    await waitFor(() => {
      expect(within(element).getByText(/A playground side answer to “And the tests\?”/)).toBeTruthy();
    });
    expect(document.querySelectorAll('[data-item-kind="side_question"]')).toHaveLength(1);
    expect(within(element).getAllByText(/./, { selector: '[data-side-entry] > p:first-child' })).toHaveLength(
      2,
    );
  });

  it('answer states: synthetic, fallback model, retry, busy, unavailable, ended – en and de', () => {
    const view = (item: SideQuestionItem) => {
      const result = render(<SideQuestionCard item={item} sessionKey={KEY} />);
      const text = result.container.textContent;
      result.unmount();
      return text;
    };
    expect(view(side({ id: 'a', order: 1, synthetic: true, response: 'No response' }))).toContain(
      'No answer available',
    );
    expect(view(side({ id: 'b', order: 1, fallbackModel: 'claude-sonnet-5' }))).toContain(
      'Answered by claude-sonnet-5',
    );
    expect(
      view(
        side({ id: 'c', order: 1, status: 'pending', response: null, retry: { attempt: 1, maxRetries: 3 } }),
      ),
    ).toContain('asking… (retry 1 of 3)');
    const failed = (code: 'SESSION_BUSY' | 'CLAUDE_CONTROL_FAILED' | 'SESSION_NOT_RUNNING') =>
      view(side({ id: 'd', order: 1, status: 'failed', response: null, error: makeError(code) }));
    expect(failed('SESSION_BUSY')).toContain('Too many side questions right now – try again in a moment');
    expect(failed('CLAUDE_CONTROL_FAILED')).toContain('Side question not available');
    expect(failed('SESSION_NOT_RUNNING')).toContain('The session ended before the answer came');
    act(() => {
      setLanguage('de');
    });
    expect(failed('SESSION_BUSY')).toContain('Gerade zu viele Seitenfragen – gleich nochmal versuchen');
    expect(view(side({ id: 'e', order: 1, status: 'pending', response: null }))).toContain(
      'Seitenfrage · nicht im Kontext',
    );
  });
});

describe('„Zurückholen“ of a waiting message (WP-66 §1.5)', () => {
  it('withdrawn → the text goes to the composer (shell request) and the entry leaves the queue', async () => {
    const taken: { sessionKey: string; text: string }[] = [];
    removers.push(
      registerShellRequestHandler('composerText', (request) => {
        taken.push({ sessionKey: request.sessionKey, text: request.text });
        return true;
      }),
    );
    const prompt = sampleQueuedPrompt();
    start([sampleItems.userMessage({ id: 'u1', order: 1 })], [prompt]);
    render(<TranscriptView sessionKey={KEY} />);
    const button = await screen.findByRole('button', { name: 'Take back into the message field' });
    await userEvent.setup().click(button);
    await waitFor(() => {
      expect(taken).toEqual([{ sessionKey: KEY, text: 'And now the tests.' }]);
    });
    expect(host().commands).toContainEqual({
      name: 'session.withdrawQueued',
      entryId: ENTRY,
      messageUuid: prompt.messageUuid,
    });
    await waitFor(() => {
      expect(document.querySelector('[data-row="queued"]')).toBeNull();
    });
  });

  it('already taken over → the notice, nothing comes back', async () => {
    const taken: string[] = [];
    removers.push(
      registerShellRequestHandler('composerText', (request) => {
        taken.push(request.text);
        return true;
      }),
    );
    // The CLI took it over meanwhile: the server's queue is empty.
    start([]);
    render(<QueuedPromptRow prompt={sampleQueuedPrompt()} sessionKey={KEY} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Take back into the message field' }));
    await waitFor(() => {
      expect(clientStore.getState().notices.map((notice) => notice.content)).toContainEqual({
        text: 'transcript.user.alreadyTaken',
      });
    });
    expect(taken).toEqual([]);
  });
});
