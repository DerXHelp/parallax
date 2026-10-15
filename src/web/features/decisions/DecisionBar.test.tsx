import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionOutcome } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import { sampleDecisions, sampleId } from '@shared/samples';
import { focusDecision } from '@web/shell/decision-focus';
import { clientStore, resetClientStore } from '@web/state/store';
import { resetDraftStore } from '../composer/state/drafts';
import { DecisionBar } from './DecisionBar';
import { DecisionCard } from './DecisionCard';
import { DEMO_ENTRIES } from './lib/demo-data';
import { renderWithHost, type Harness } from './lib/testing';
import { resetDecisionBarState } from './state/bar-store';

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
  localStorage.clear();
});

function shownCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-decision-id]');
}

function notices() {
  return clientStore.getState().notices.map((notice) => notice.content);
}

/** Simulates the server resolving a decision without this window (other window / Claude). */
function resolveRemotely(
  h: Harness,
  entry: 'queue' | 'permission',
  decisionId: string,
  outcome: DecisionOutcome,
) {
  const entryId = DEMO_ENTRIES[entry];
  const view = h.host.view(entryId);
  const decision = view?.decisions.find((candidate) => candidate.id === decisionId);
  const toolCall = view?.items.find(
    (item) => item.kind === 'tool_call' && item.toolUseId === decision?.toolUseId,
  );
  const ops: SessionOp[] = [
    {
      op: 'decision.resolved',
      decisionId,
      outcome,
      byClientId: sampleId('cl', 0xbeef),
      at: new Date().toISOString(),
    },
  ];
  if (toolCall?.kind === 'tool_call' && decision !== undefined) {
    ops.push({
      op: 'item.upsert',
      item: { ...toolCall, decision: { decisionId, kind: decision.kind, planVersion: null, outcome } },
    });
  }
  act(() => {
    h.host.pushOps(entryId, ops);
  });
}

describe('DecisionBar', () => {
  it('renders nothing without decisions', () => {
    harness = renderWithHost((key) => <DecisionBar sessionKey={key('idle')} />, { entries: ['idle'] });
    expect(screen.queryByRole('region', { name: 'Decisions' })).toBeNull();
  });

  it('shows the oldest open decision with "+2 more" and lets the user view another one', async () => {
    harness = renderWithHost((key) => <DecisionBar sessionKey={key('queue')} />, { entries: ['queue'] });
    const user = userEvent.setup();
    expect(await screen.findByText('Bash needs your permission')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '+2 more · Open decisions of this session' }));
    expect(
      await screen.findByRole('menuitemradio', { name: /Subagent: Explore the store code/ }),
    ).toBeTruthy();
    await user.click(screen.getByRole('menuitemradio', { name: /Claude has a question/ }));
    await waitFor(() => {
      expect(shownCard()?.dataset.decisionKind).toBe('question');
    });
    expect(screen.getByText('Subagent: Explore the store code')).toBeTruthy();
    expect(document.activeElement).toBe(shownCard());
  });

  it('handles "Go to decision": shows that decision and focuses its card', async () => {
    const h = renderWithHost((key) => <DecisionBar sessionKey={key('queue')} />, { entries: ['queue'] });
    harness = h;
    await screen.findByText('Bash needs your permission');
    let handled = false;
    act(() => {
      handled = focusDecision(h.key('queue'), sampleId('dc', 0xa53));
    });
    expect(handled).toBe(true);
    expect(shownCard()?.dataset.decisionKind).toBe('plan');
    expect(document.activeElement).toBe(shownCard());
  });

  it('announces a new decision politely without moving the focus', async () => {
    const h = renderWithHost(
      (key) => (
        <>
          <input aria-label="busy typing" />
          <DecisionBar sessionKey={key('idle')} />
        </>
      ),
      { entries: ['idle'] },
    );
    harness = h;
    const input = screen.getByRole('textbox', { name: 'busy typing' });
    act(() => {
      input.focus();
    });
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.idle, [
        {
          op: 'decision.upsert',
          decision: sampleDecisions.permission({ entryId: DEMO_ENTRIES.idle, id: sampleId('dc', 0xc1) }),
        },
      ]);
    });
    expect(await screen.findByText('Claude asks for permission: Bash')).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('a decision answered in another window disappears with a short notice', async () => {
    const h = renderWithHost((key) => <DecisionBar sessionKey={key('queue')} />, { entries: ['queue'] });
    harness = h;
    await screen.findByText('Bash needs your permission');
    resolveRemotely(h, 'queue', sampleId('dc', 0xa51), {
      type: 'allowed',
      remember: null,
      acceptEdits: false,
    });
    await waitFor(() => {
      expect(shownCard()?.dataset.decisionKind).toBe('question');
    });
    expect(notices()).toEqual([{ text: 'decisions.notices.elsewhere.allowed' }]);
  });

  it('a request withdrawn by Claude gets its own notice', async () => {
    const h = renderWithHost((key) => <DecisionBar sessionKey={key('permission')} />, {
      entries: ['permission'],
    });
    harness = h;
    await screen.findByText('Bash needs your permission');
    resolveRemotely(h, 'permission', sampleId('dc', 0xa11), { type: 'cancelled', reason: 'signal_aborted' });
    await waitFor(() => {
      expect(shownCard()).toBeNull();
    });
    expect(notices()).toEqual([{ text: 'decisions.notices.withdrawn.signal_aborted' }]);
  });

  it('an answer of this window produces no "elsewhere" notice and keeps the focus in the bar', async () => {
    const h = renderWithHost((key) => <DecisionBar sessionKey={key('queue')} />, { entries: ['queue'] });
    harness = h;
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Allow once' }));
    await waitFor(() => {
      expect(shownCard()?.dataset.decisionKind).toBe('question');
    });
    expect(notices()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Decisions' }));
    expect(h.commands('decision.respond')).toHaveLength(1);
  });

  it('expired decisions are read-only: "Continue" resumes, plans offer "Continue & implement"', async () => {
    const h = renderWithHost((key) => <DecisionBar sessionKey={key('expired')} />, { entries: ['expired'] });
    harness = h;
    const user = userEvent.setup();
    expect(await screen.findByText('Expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep planning' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Continue & implement · Accept edits' }));
    expect(h.commands('decision.respond').map((cmd) => cmd.response)).toEqual([
      { kind: 'plan', response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: null } },
    ]);
  });

  it('"Continue" on an expired permission sends session.resume', async () => {
    const h = renderWithHost((key) => <DecisionBar sessionKey={key('expired')} />, { entries: ['expired'] });
    harness = h;
    const user = userEvent.setup();
    await screen.findByText('Expired');
    act(() => {
      focusDecision(h.key('expired'), sampleId('dc', 0xa62));
    });
    expect(shownCard()?.dataset.decisionKind).toBe('permission');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(h.commands('session.resume')).toEqual([{ name: 'session.resume', entryId: DEMO_ENTRIES.expired }]);
    expect(h.commands('decision.respond')).toEqual([]);
  });
});

describe('DecisionCard slot (architecture §2.3e)', () => {
  it('transcript placement is read-only with plan text, status and "Go to decision"', async () => {
    const h = renderWithHost(
      (key) => (
        <>
          <DecisionCard sessionKey={key('plan')} decisionId={sampleId('dc', 0xa41)} placement="transcript" />
          <DecisionBar sessionKey={key('plan')} />
        </>
      ),
      { entries: ['plan'] },
    );
    harness = h;
    const user = userEvent.setup();
    const article = await screen.findByRole('article', { name: /Plan v2 ready/ });
    expect(article.querySelector('[data-decision-action]')).toBeNull();
    expect(article.textContent).toContain('Plan ready for review');
    expect(screen.getAllByTestId('markdown')[0]?.textContent).toContain('# Move the session registry');
    const button = screen.getByRole('button', { name: 'Go to decision' });
    await user.click(button);
    expect(document.activeElement).toBe(shownCard());
    expect(document.querySelectorAll('[data-decision-action]').length).toBeGreaterThan(0);
  });

  it('renders null once the decision is resolved', async () => {
    const h = renderWithHost(
      (key) => (
        <>
          <DecisionCard sessionKey={key('plan')} decisionId={sampleId('dc', 0xa41)} placement="transcript" />
          <DecisionBar sessionKey={key('plan')} />
        </>
      ),
      { entries: ['plan'] },
    );
    harness = h;
    await screen.findByRole('article');
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.plan, [
        {
          op: 'decision.resolved',
          decisionId: sampleId('dc', 0xa41),
          outcome: { type: 'plan_revised' },
          byClientId: null,
          at: new Date().toISOString(),
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('article')).toBeNull();
    });
  });

  it('bar placement is the operable card', async () => {
    harness = renderWithHost(
      (key) => (
        <DecisionCard sessionKey={key('permission')} decisionId={sampleId('dc', 0xa11)} placement="bar" />
      ),
      { entries: ['permission'] },
    );
    // useDecision does not subscribe: the bar/transcript above holds the subscription.
    harness.running.connection.subscribe(DEMO_ENTRIES.permission);
    expect(await screen.findByRole('button', { name: 'Allow once' })).toBeTruthy();
  });
});
