import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetClientStore } from '@web/state/store';
import { Composer } from '../composer/Composer';
import { getDraft, resetDraftStore, setDraft } from '../composer/state/drafts';
import { DecisionBar } from './DecisionBar';
import { renderWithHost, type Harness } from './lib/testing';
import { PlanSidePanel } from './PlanSidePanel';
import { readApproveMode, resetDecisionBarState } from './state/bar-store';

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

function start(options: { panel?: boolean; composer?: boolean } = {}): Harness {
  harness = renderWithHost(
    (key) => (
      <>
        {options.panel === false ? null : <PlanSidePanel sessionKey={key('plan')} />}
        <DecisionBar sessionKey={key('plan')} />
        {options.composer === true ? <Composer sessionKey={key('plan')} /> : null}
      </>
    ),
    { entries: ['plan'] },
  );
  return harness;
}

function approvals(h: Harness) {
  return h.commands('decision.respond').map((cmd) => cmd.response);
}

describe('PlanCard (Plan "Plan-Modus & Plan-Freigabe")', () => {
  it('shows "Plan v2 ready", title, summary and the context gauge', async () => {
    start();
    expect(await screen.findByText('Plan v2 ready')).toBeTruthy();
    expect(screen.getByText('· Move the session registry to JSON files')).toBeTruthy();
    expect(screen.getByText(/Replace the SQLite registry/)).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Context' });
    expect(meter.getAttribute('aria-valuenow')).toBe('78');
  });

  it('"Implement" sends only the chosen mode – default accept edits', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Implement · Accept edits' }));
    expect(approvals(h)).toEqual([
      { kind: 'plan', response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: null } },
    ]);
    await waitFor(() => {
      expect(readApproveMode()).toBe('acceptEdits');
    });
  });

  it.each([
    ['With auto mode', 'Auto', 'auto'],
    ['Approve each change', 'Each change', 'default'],
  ] as const)('the ▾ menu picks "%s" and the main button implements with it', async (item, short, mode) => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'How should Claude implement the plan?' }));
    await user.click(await screen.findByRole('menuitemradio', { name: item }));
    expect(approvals(h)).toEqual([]);
    await user.click(await screen.findByRole('button', { name: `Implement · ${short}` }));
    expect(approvals(h)).toEqual([
      { kind: 'plan', response: { behavior: 'approve', mode, editedPlan: null } },
    ]);
    await waitFor(() => {
      expect(readApproveMode()).toBe(mode);
    });
  });

  it('remembers the last choice for the next plan', async () => {
    localStorage.setItem('parallax.decisions.approveMode', 'auto');
    start();
    expect(await screen.findByRole('button', { name: 'Implement · Auto' })).toBeTruthy();
  });

  it('"With fresh context" is shown but disabled (Phase 3)', async () => {
    start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'How should Claude implement the plan?' }));
    const fresh = await screen.findByRole('menuitem', { name: /With fresh context/ });
    expect(fresh.getAttribute('aria-disabled')).toBe('true');
  });

  it('"Keep planning" without text moves the focus into the composer', async () => {
    const h = start({ composer: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Keep planning' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message to Claude' }));
    expect(approvals(h)).toEqual([]);
  });

  it('"Keep planning with feedback" sends the composer text as revise feedback', async () => {
    const h = start({ composer: true });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message to Claude' }), 'Add tests first');
    // Both the bar and the composer offer the action; the bar's button comes first.
    const [fromBar] = screen.getAllByRole('button', { name: 'Keep planning with feedback' });
    if (fromBar === undefined) throw new Error('missing');
    await user.click(fromBar);
    expect(approvals(h)).toEqual([
      { kind: 'plan', response: { behavior: 'revise', feedback: 'Add tests first' } },
    ]);
    await waitFor(() => {
      expect(getDraft(h.key('plan'))).toBe('');
    });
  });

  it('Mod+Enter on a non-answer button of the card does nothing; on the card itself it implements', async () => {
    const h = start();
    const user = userEvent.setup();
    const keep = await screen.findByRole('button', { name: 'Keep planning' });
    act(() => {
      keep.focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(approvals(h)).toEqual([]);
    const card = document.querySelector<HTMLElement>('[data-decision-id]');
    act(() => {
      card?.focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(approvals(h)).toEqual([
      { kind: 'plan', response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: null } },
    ]);
  });

  it('typing + Enter in the composer gives feedback and never approves', async () => {
    const h = start({ composer: true });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message to Claude' }), 'looks good{Enter}');
    expect(approvals(h)).toEqual([
      { kind: 'plan', response: { behavior: 'revise', feedback: 'looks good' } },
    ]);
  });

  it('"Open plan" shows the full plan in the side panel (Markdown slot); Esc closes it', async () => {
    start();
    const user = userEvent.setup();
    const open = await screen.findByRole('button', { name: 'Open plan' });
    await user.click(open);
    const panel = await screen.findByRole('complementary', { name: 'Plan v2' });
    expect(panel.textContent).toContain('## Risks');
    expect(document.activeElement).toBe(panel);
    expect(screen.getByRole('button', { name: 'Close plan', expanded: true })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open plan' }));
  });

  it('keeps the plan readable in the panel after the decision closed', async () => {
    const h = start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open plan' }));
    act(() => {
      setDraft(h.key('plan'), 'more detail');
    });
    await user.click(screen.getByRole('button', { name: 'Keep planning with feedback' }));
    expect(await screen.findByText('This decision is no longer open.')).toBeTruthy();
    expect(screen.getByRole('complementary').textContent).toContain('## Risks');
  });

  it('without a mounted side panel the plan opens inside the card', async () => {
    start({ panel: false });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open plan' }));
    expect(document.querySelector('[data-slot="plan-inline"]')?.textContent).toContain('## Tests');
  });
});
