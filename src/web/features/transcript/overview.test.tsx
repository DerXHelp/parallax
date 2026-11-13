import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import { makeError } from '@shared/errors';
import {
  sampleDetail,
  sampleId,
  sampleItems,
  sampleSessionSnapshot,
  sampleSummary,
  sampleTime,
} from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { clientStore, resetClientStore } from '@web/state/store';
import { sinceFacts } from './lib/since';
import { resetExpansion } from './state/expansion';
import { installResizeObserver, installScrollEvents, startTranscriptScenario } from './testing';
import { TranscriptView } from './TranscriptView';

/**
 * WP-65 – the transcript's overview parts: the card "Since you were last here" (§1.2, from the
 * session's `lastSeenAt` held at opening) and "Move to background" on a running Bash call and a
 * running subagent (§1.5).
 */

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await import('./markdown/MarkdownRenderer');
}, 180_000);

let running: RunningScenario | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreScrollEvents: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver({ viewport: 2000, item: 40 });
  restoreScrollEvents = installScrollEvents();
});

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  resetExpansion();
  restoreResizeObserver?.();
  restoreScrollEvents?.();
});

const ENTRY = sampleId('en', 65);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
/** Seen at second 100: everything later is new. */
const SEEN = sampleTime(100);

function prompt(id: string, order: number, at: number, text: string): TranscriptItem {
  return { ...sampleItems.userMessage(), id, order, at: sampleTime(at), text: { text, truncated: null } };
}

function edit(id: string, order: number, at: number, path: string, p: Partial<Extract<TranscriptItem, { kind: 'tool_call' }>> = {}) {
  return sampleItems.toolCall({
    id,
    order,
    at: sampleTime(at),
    toolUseId: `toolu_${id}`,
    toolName: 'Edit',
    input: { file_path: path, old_string: 'a', new_string: 'b' },
    status: 'done',
    ...p,
  });
}

function turn(id: string, order: number, at: number, costUsdTurn: number | null = 0.01): TranscriptItem {
  return sampleItems.turnResult({ id, order, at: sampleTime(at), costUsdTurn });
}

function history(): TranscriptItem[] {
  return [
    prompt('u1', 1, 10, 'Old question.'),
    edit('e0', 2, 20, 'D:\\work\\old.ts'),
    turn('r1', 3, 30),
    prompt('u2', 4, 200, 'Fix the login.'),
    edit('e1', 5, 210, 'D:\\work\\src\\login.ts', {
      decision: { decisionId: sampleId('dc', 1), kind: 'permission', planVersion: null, outcome: { type: 'allowed', remember: null, acceptEdits: false } },
    }),
    edit('e2', 6, 220, 'D:\\work\\src\\login.ts'),
    ...[1, 2, 3, 4, 5, 6].map((n) => edit(`f${String(n)}`, 6 + n, 230 + n, `D:\\work\\src\\file${String(n)}.ts`)),
    turn('r2', 13, 300, 0.02),
    turn('r3', 14, 310, null),
  ];
}

describe('sinceFacts', () => {
  it('counts what came after lastSeenAt (turns, files once, decisions, cost, first new item)', () => {
    const facts = sinceFacts(history(), SEEN);
    expect(facts).toMatchObject({ turns: 2, answered: 1, open: 0, firstItemId: 'u2' });
    expect(facts?.costUsd).toBeCloseTo(0.02);
    expect(facts?.files).toEqual([
      'D:\\work\\src\\login.ts',
      ...[1, 2, 3, 4, 5, 6].map((n) => `D:\\work\\src\\file${String(n)}.ts`),
    ]);
  });

  it('nothing without a new turn; synthetic turns do not count; failed edits are no changes', () => {
    expect(sinceFacts(history(), sampleTime(400))).toBeNull();
    expect(
      sinceFacts([edit('x', 1, 200, 'a.ts', { status: 'error' }), sampleItems.turnResult({ id: 'r', order: 2, at: sampleTime(210), synthetic: true })], SEEN),
    ).toBeNull();
    expect(sinceFacts([edit('x', 1, 200, 'a.ts', { status: 'error' }), turn('r', 2, 210)], SEEN)?.files).toEqual([]);
    expect(sinceFacts(history(), 'not a date')).toBeNull();
  });
});

function start(items: TranscriptItem[], lastSeenAt: string | null): void {
  running = startTranscriptScenario([
    {
      snapshot: sampleSessionSnapshot({ entryId: ENTRY, seq: 0, items, detail: sampleDetail({ entryId: ENTRY }) }),
      summary: sampleSummary({
        entryId: ENTRY,
        lastSeenAt,
        turnSummary: { source: 'claude', text: 'Login fixed; tests pass.', category: 'completed', needsAction: false, at: sampleTime(305) },
      }),
    },
  ]);
}

describe('"Since you were last here" (WP-65 §1.2)', () => {
  it('shows turns, decisions, five files + "and n more", the summary; closes', async () => {
    start(history(), SEEN);
    render(<TranscriptView sessionKey={KEY} />);
    const card = await screen.findByRole('region', { name: 'Since you were last here' });
    expect(within(card).getByText(/2 turns/)).toBeTruthy();
    expect(within(card).getByText(/1 decision answered/)).toBeTruthy();
    // Cost only for API-key profiles (like the turn footer).
    expect(within(card).queryByText(/Cost/)).toBeNull();
    const files = card.querySelector('[data-slot="since-files"]');
    expect(files?.textContent).toContain('7 changed files:');
    expect(files?.textContent).toContain('src\\login.ts');
    expect(files?.textContent).toContain('and 2 more');
    expect(files?.textContent).not.toContain('file6.ts');
    expect(within(card).getByText('Login fixed; tests pass.')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'To the first new message' })).toBeTruthy();
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Close the summary' }));
    expect(screen.queryByRole('region', { name: 'Since you were last here' })).toBeNull();
  });

  it('the value at opening counts: a later lastSeenAt does not move the card; no card without lastSeenAt', async () => {
    start(history(), SEEN);
    const view = render(<TranscriptView sessionKey={KEY} />);
    expect(await screen.findByRole('region', { name: 'Since you were last here' })).toBeTruthy();
    act(() => {
      running?.host.patchSummary(ENTRY, { lastSeenAt: sampleTime(500) });
    });
    await waitFor(() => {
      expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.summaries[ENTRY]?.lastSeenAt).toBe(sampleTime(500));
    });
    expect(screen.getByRole('region', { name: 'Since you were last here' })).toBeTruthy();
    view.unmount();
    running?.stop();
    resetClientStore();
    start(history(), null);
    render(<TranscriptView sessionKey={KEY} />);
    expect(await screen.findByText('Fix the login.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Since you were last here' })).toBeNull();
  });
});

describe('"Move to background" (WP-65 §1.5)', () => {
  function runningItems(): TranscriptItem[] {
    return [
      prompt('u1', 1, 10, 'Run the tests.'),
      sampleItems.toolCall({
        id: 'b1',
        order: 2,
        at: sampleTime(20),
        toolUseId: 'toolu_bash',
        toolName: 'Bash',
        input: { command: 'pnpm test --watch', description: 'Run the test suite' },
        status: 'running',
        result: null,
      }),
      sampleItems.toolCall({
        id: 'a1',
        order: 3,
        at: sampleTime(21),
        toolUseId: 'toolu_agent',
        toolName: 'Agent',
        input: { description: 'Research', prompt: 'Look around', subagent_type: 'Explore' },
        status: 'running',
        result: null,
      }),
      sampleItems.toolCall({
        id: 'b2',
        order: 4,
        at: sampleTime(22),
        toolUseId: 'toolu_done',
        toolName: 'Bash',
        input: { command: 'ls' },
        status: 'done',
      }),
    ];
  }

  it('on the running Bash call and the running subagent only; sends session.backgroundTasks', async () => {
    start(runningItems(), null);
    render(<TranscriptView sessionKey={KEY} />);
    const bash = await screen.findByRole('button', { name: 'Move “Run the test suite” to the background' });
    expect(screen.getByRole('button', { name: 'Move “Research” to the background' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /to the background$/ })).toHaveLength(2);
    await userEvent.setup().click(bash);
    await waitFor(() => {
      expect(running?.host.commands.filter((cmd) => cmd.name === 'session.backgroundTasks')).toEqual([
        { name: 'session.backgroundTasks', entryId: ENTRY, toolUseId: 'toolu_bash' },
      ]);
    });
    // The fake host moves the call: the row reports `background` and drops the button.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Move “Run the test suite” to the background' })).toBeNull();
    });
  });

  it('a refusal becomes a notice and frees the button', async () => {
    start(runningItems(), null);
    running?.host.failNext('session.backgroundTasks', makeError('CLAUDE_CONTROL_FAILED', { method: 'backgroundTasks' }));
    render(<TranscriptView sessionKey={KEY} />);
    const agent = await screen.findByRole('button', { name: 'Move “Research” to the background' });
    await userEvent.setup().click(agent);
    await waitFor(() => {
      expect(clientStore.getState().notices.some((notice) => notice.id === 'transcript-background-toolu_agent')).toBe(true);
    });
    expect(agent.hasAttribute('disabled')).toBe(false);
  });
});
