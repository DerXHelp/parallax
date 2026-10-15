import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import type * as Virtua from 'virtua';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import type { Decision, QueuedPrompt, SessionSummary, TranscriptItem } from '@shared/model';
import {
  sampleDecisions,
  sampleDetail,
  sampleId,
  sampleItems,
  sampleQueuedPrompt,
  sampleResponses,
  sampleSessionSnapshot,
  sampleSummary,
  sampleSystemItems,
  sampleUuid,
} from '@shared/samples';
import type * as FormatModule from '@web/i18n/format';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { FeatureSlotsProvider, type DecisionCardSlotProps, type FeatureSlots } from '@web/shell/slots';
import { sendCommand, useDecision } from '@web/state/hooks';
import { resetClientStore } from '@web/state/store';
import { resetExpansion } from './state/expansion';
import { resetFullTexts } from './state/full-text';
import { installResizeObserver, startTranscriptScenario } from './testing';
import { TranscriptView } from './TranscriptView';

/** Render counters: the list (TranscriptList → VList) and the turn footer (formats its duration once). */
const counts = vi.hoisted(() => ({
  list: 0,
  duration: 0,
  listRendered() {
    this.list++;
  },
}));
vi.mock('virtua', async (importOriginal) => {
  const actual = await importOriginal<typeof Virtua>();
  const Original = actual.VList;
  function CountingVList(props: ComponentProps<typeof Original>) {
    counts.listRendered();
    return <Original {...props} />;
  }
  return { ...actual, VList: CountingVList };
});
vi.mock('@web/i18n/format', async (importOriginal) => {
  const actual = await importOriginal<typeof FormatModule>();
  return {
    ...actual,
    formatDuration: (...args: Parameters<typeof actual.formatDuration>) => {
      counts.duration++;
      return actual.formatDuration(...args);
    },
  };
});

let running: RunningScenario | null = null;
let restoreResizeObserver: (() => void) | null = null;

beforeAll(async () => {
  await import('./markdown/MarkdownRenderer');
}, 60_000);

beforeEach(() => {
  restoreResizeObserver = installResizeObserver({ viewport: 600, item: 48 });
});

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  resetExpansion();
  resetFullTexts();
  restoreResizeObserver?.();
  counts.list = 0;
  counts.duration = 0;
});

function keyOf(entryId: EntryId): string {
  return makeSessionKey(LOCAL_HOST_ID, entryId);
}

function session(
  n: number,
  items: TranscriptItem[],
  options: { decisions?: Decision[]; queue?: QueuedPrompt[]; summary?: Partial<SessionSummary> } = {},
) {
  const entryId = sampleId('en', n);
  return {
    entryId,
    key: keyOf(entryId),
    snapshot: sampleSessionSnapshot({
      entryId,
      seq: 0,
      items,
      decisions: options.decisions ?? [],
      detail: sampleDetail({ entryId, queue: options.queue ?? [] }),
    }),
    summary: sampleSummary({ entryId, ...options.summary }),
  };
}

function start(...sessions: ReturnType<typeof session>[]): RunningScenario {
  running = startTranscriptScenario(sessions);
  return running;
}

const BASIC_ITEMS = (): TranscriptItem[] => [
  sampleItems.userMessage(),
  sampleItems.thinking(),
  sampleItems.assistantText(),
  sampleItems.toolCall(),
  sampleItems.turnResult(),
];

describe('TranscriptView', () => {
  it('renders the top-level items of a session', async () => {
    const s = session(1, BASIC_ITEMS());
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    expect(await screen.findByText('Say OK.')).toBeTruthy();
    expect(await screen.findByText('OK')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByText('List files')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Turn summary' }).textContent).toContain('2.1 sec');
    expect(screen.getByRole('region', { name: 'Transcript' })).toBeTruthy();
  });

  it('applies streaming deltas to the affected row only (the list does not re-render)', async () => {
    const s = session(2, BASIC_ITEMS());
    const scenario = start(s);
    render(<TranscriptView sessionKey={s.key} />);
    await screen.findByText('OK');
    const live = sampleItems.assistantText({
      id: 'live:0',
      messageId: 'live',
      blockIndex: 0,
      order: 6,
      text: '',
      streaming: true,
    });
    await act(async () => {
      scenario.host.pushOps(s.entryId, [{ op: 'item.upsert', item: live }]);
      scenario.connection.flush();
      await Promise.resolve();
    });
    const listRenders = counts.list;
    const footerRenders = counts.duration;
    await act(async () => {
      for (const chunk of ['Hel', 'lo', ' world']) {
        scenario.host.pushOps(s.entryId, [
          { op: 'item.delta', itemId: 'live:0', field: 'text', append: chunk },
        ]);
        scenario.connection.flush();
        await Promise.resolve();
      }
    });
    expect(await screen.findByText('Hello world')).toBeTruthy();
    expect(document.querySelector('[data-item-kind="assistant_text"][data-streaming="true"]')).not.toBeNull();
    expect(counts.list).toBe(listRenders);
    expect(counts.duration).toBe(footerRenders);
  });

  it('virtualizes long transcripts: only a window of rows is mounted', async () => {
    const items = Array.from({ length: 400 }, (_, i) =>
      sampleItems.userMessage({
        id: `px:long:${String(i)}`,
        order: i + 1,
        text: { text: `message ${String(i)}`, truncated: null },
      }),
    );
    const s = session(3, items);
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    await screen.findByRole('region', { name: 'Transcript' });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-row="item"]').length).toBeGreaterThan(0);
    });
    const mounted = document.querySelectorAll('[data-row]').length;
    // The snapshot is trimmed to 150 items (+ the "load earlier" row); far fewer are mounted.
    expect(mounted).toBeLessThan(60);
  });

  it('loads earlier items when the list is scrolled to the top', async () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      sampleItems.userMessage({
        id: `px:early:${String(i)}`,
        order: i + 1,
        text: { text: `early ${String(i)}`, truncated: null },
      }),
    );
    const s = session(4, items);
    const scenario = start(s);
    render(<TranscriptView sessionKey={s.key} />);
    const region = await screen.findByRole('region', { name: 'Transcript' });
    act(() => {
      region.scrollTop = 0;
      fireEvent.scroll(region);
    });
    await waitFor(() => {
      expect(scenario.host.commands.some((cmd) => cmd.name === 'transcript.loadEarlier')).toBe(true);
    });
  });

  it('groups subagent items under the Agent card, collapsed in phase 1', async () => {
    const user = userEvent.setup();
    const agent = sampleItems.toolCall({
      id: 'msg_agent:0',
      messageId: 'msg_agent',
      blockIndex: 0,
      order: 2,
      toolUseId: 'toolu_agent',
      toolName: 'Agent',
      input: { description: 'Find usages', subagent_type: 'Explore', prompt: 'Find all usages.' },
      status: 'done',
      result: null,
    });
    const child = sampleItems.assistantText({
      id: 'msg_child:0',
      messageId: 'msg_child',
      blockIndex: 0,
      order: 3,
      parentToolUseId: 'toolu_agent',
      text: 'child answer',
    });
    const childTool = sampleItems.toolCall({
      id: 'msg_child:1',
      messageId: 'msg_child',
      blockIndex: 1,
      order: 4,
      parentToolUseId: 'toolu_agent',
      toolUseId: 'toolu_child',
    });
    const after = sampleItems.assistantText({
      id: 'msg_after:0',
      messageId: 'msg_after',
      blockIndex: 0,
      order: 5,
      text: 'after the agent',
    });
    const s = session(5, [sampleItems.userMessage(), agent, child, childTool, after]);
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    expect(await screen.findByText('after the agent')).toBeTruthy();
    expect(screen.getByText('Find usages')).toBeTruthy();
    // 4 top-level rows: user, agent, after – children are not rows of the list.
    expect(document.querySelectorAll('[data-row="item"]')).toHaveLength(3);
    expect(screen.queryByText('child answer')).toBeNull();
    await user.click(screen.getByRole('button', { name: '2 steps' }));
    const steps = document.querySelector('[data-slot="agent-steps"]');
    if (!(steps instanceof HTMLElement)) throw new Error('no steps');
    expect(await within(steps).findByText('child answer')).toBeTruthy();
    expect(within(steps).getByText('List files')).toBeTruthy();
  });

  it('plan card: open/expired via the DecisionCard slot, resolved state from tool_call.decision', async () => {
    const entryId = sampleId('en', 6);
    const open = sampleDecisions.plan({
      id: sampleId('dc', 61),
      entryId,
      toolUseId: 'toolu_plan_open',
      version: 3,
    });
    const expired = sampleDecisions.plan({
      id: sampleId('dc', 62),
      entryId,
      toolUseId: 'toolu_plan_expired',
      version: 4,
      state: 'expired',
    });
    const plan = (n: number, patch: Partial<Parameters<typeof sampleItems.toolCall>[0]>) =>
      sampleItems.toolCall({
        id: `msg_plan${String(n)}:0`,
        messageId: `msg_plan${String(n)}`,
        blockIndex: 0,
        order: n + 1,
        toolName: 'ExitPlanMode',
        input: { plan: `# Plan ${String(n)}\n\nStep ${String(n)}`, planFilePath: 'C:\\plans\\p.md' },
        result: null,
        ...patch,
      });
    const s = session(
      6,
      [
        sampleItems.userMessage(),
        plan(1, {
          status: 'denied',
          decision: {
            decisionId: sampleId('dc', 63),
            kind: 'plan',
            planVersion: 1,
            outcome: { type: 'plan_revised' },
          },
        }),
        plan(2, {
          status: 'done',
          decision: {
            decisionId: sampleId('dc', 64),
            kind: 'plan',
            planVersion: 2,
            outcome: { type: 'plan_approved', mode: 'auto', edited: false },
          },
        }),
        plan(3, {
          toolUseId: 'toolu_plan_open',
          status: 'awaiting_decision',
          decision: { decisionId: open.id, kind: 'plan', planVersion: 3, outcome: null },
        }),
        plan(4, {
          toolUseId: 'toolu_plan_expired',
          status: 'awaiting_decision',
          decision: { decisionId: expired.id, kind: 'plan', planVersion: 4, outcome: null },
        }),
      ],
      { decisions: [open, expired] },
    );
    start(s);
    function TestDecisionCard({ sessionKey, decisionId, placement }: DecisionCardSlotProps) {
      const decision = useDecision(sessionKey, decisionId);
      if (decision === null) return null;
      return <div data-testid="decision-card" data-placement={placement} data-state={decision.state} />;
    }
    const slots: Partial<FeatureSlots> = { DecisionCard: TestDecisionCard };
    render(
      <FeatureSlotsProvider slots={slots}>
        <TranscriptView sessionKey={s.key} />
      </FeatureSlotsProvider>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('decision-card')).toHaveLength(2);
    });
    expect(
      screen.getAllByTestId('decision-card').map((card) => [card.dataset.placement, card.dataset.state]),
    ).toEqual([
      ['transcript', 'open'],
      ['transcript', 'expired'],
    ]);
    expect(screen.getByText('Sent back for revision')).toBeTruthy();
    expect(screen.getByText('Approved – Auto')).toBeTruthy();
    expect(await screen.findByText('Step 2')).toBeTruthy();

    await act(async () => {
      await sendCommand(s.key, {
        name: 'decision.respond',
        entryId,
        decisionId: open.id,
        response: sampleResponses.planApprove,
      });
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('decision-card')).toHaveLength(1);
    });
    expect(screen.getByText('Approved – Accept edits')).toBeTruthy();
    expect(screen.getByText('Plan v3')).toBeTruthy();
  });

  it('tool calls with an expired decision say so and lead to the bar (R2W-14)', async () => {
    const entryId = sampleId('en', 12);
    const expired = sampleDecisions.permission({
      id: sampleId('dc', 121),
      entryId,
      toolUseId: 'toolu_perm_expired',
      state: 'expired',
    });
    const open = sampleDecisions.permission({
      id: sampleId('dc', 122),
      entryId,
      toolUseId: 'toolu_perm_open',
    });
    const call = (n: number, patch: Partial<Parameters<typeof sampleItems.toolCall>[0]>) =>
      sampleItems.toolCall({
        id: `msg_perm${String(n)}:0`,
        messageId: `msg_perm${String(n)}`,
        blockIndex: 0,
        order: n + 1,
        toolName: 'Bash',
        input: { command: 'mkdir build' },
        result: null,
        ...patch,
      });
    const s = session(
      12,
      [
        sampleItems.userMessage(),
        call(1, {
          toolUseId: 'toolu_perm_expired',
          status: 'interrupted',
          decision: { decisionId: expired.id, kind: 'permission', planVersion: null, outcome: null },
        }),
        call(2, {
          toolUseId: 'toolu_perm_open',
          status: 'awaiting_decision',
          decision: { decisionId: open.id, kind: 'permission', planVersion: null, outcome: null },
        }),
      ],
      { decisions: [expired, open] },
    );
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    expect(await screen.findByText('Expired – continue in the decision bar.')).toBeTruthy();
    expect(screen.getByText('Waiting for your decision in the decision bar.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Go to decision' })).toHaveLength(2);
  });

  it('shows queued prompts grey until the CLI takes them over', async () => {
    const taken = sampleUuid(77);
    const s = session(
      7,
      [
        sampleItems.userMessage(),
        sampleItems.userMessage({ id: taken, order: 2, text: { text: 'already an item', truncated: null } }),
      ],
      {
        queue: [
          sampleQueuedPrompt({ messageUuid: taken, text: { text: 'already an item', truncated: null } }),
          sampleQueuedPrompt({
            messageUuid: sampleUuid(78),
            text: { text: 'still waiting', truncated: null },
          }),
        ],
      },
    );
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    expect(await screen.findByText('still waiting')).toBeTruthy();
    const queued = [...document.querySelectorAll('[data-item-kind="user_message"][data-queued="true"]')].map(
      (el) => el.textContent,
    );
    expect(queued).toHaveLength(2);
    expect(queued.join('|')).toContain('already an item');
    expect(screen.getAllByText('Queued – sent after the current step')).toHaveLength(2);
    expect(within(document.body).getByText('Say OK.').closest('[data-queued]')).toBeNull();
  });

  it('shows costs only for API-key profiles and the model of a message from another model', async () => {
    const items = (): TranscriptItem[] => [
      sampleItems.userMessage(),
      sampleItems.assistantText({ model: 'claude-sonnet-5-5', text: 'planned elsewhere' }),
      sampleItems.turnResult({ costUsdTurn: 0.0021 }),
    ];
    const subscription = session(8, items(), { summary: { apiKeySource: 'none' } });
    const apiKey = session(9, items(), { summary: { apiKeySource: 'ANTHROPIC_API_KEY' } });
    start(subscription, apiKey);
    const { unmount } = render(<TranscriptView sessionKey={subscription.key} />);
    expect(await screen.findByText('planned elsewhere')).toBeTruthy();
    // init.model is Haiku (sampleDetail): the Sonnet message shows its model.
    expect(document.querySelector('[data-slot="model-badge"]')?.textContent).toContain('claude-sonnet-5-5');
    expect(screen.queryByText('$0.0021')).toBeNull();
    unmount();
    render(<TranscriptView sessionKey={apiKey.key} />);
    expect(await screen.findByText('$0.0021')).toBeTruthy();
  });

  it('renders system items and hides synthetic turn footers', async () => {
    const s = session(10, [
      sampleSystemItems.compact_boundary({ order: 1 }),
      sampleSystemItems.rate_limit({
        order: 2,
        info: { ...sampleSystemItems.rate_limit().info, status: 'rejected' },
      }),
      sampleSystemItems.unknown({ order: 3 }),
      sampleSystemItems.conversation_reset({ order: 4 }),
      sampleItems.turnResult({ id: sampleUuid(90), order: 5, synthetic: true }),
    ]);
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    expect(await screen.findByText('Context compacted automatically · 160K → 30K tokens')).toBeTruthy();
    expect(screen.getByText('Usage limit reached')).toBeTruthy();
    expect(screen.getByText('Unknown event system/brand_new')).toBeTruthy();
    expect(screen.getByText('New conversation (clear)')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Turn summary' })).toBeNull();
  });

  it('shows an empty state without items', async () => {
    const s = session(11, []);
    start(s);
    render(<TranscriptView sessionKey={s.key} />);
    expect(await screen.findByText('No messages yet.')).toBeTruthy();
  });
});
