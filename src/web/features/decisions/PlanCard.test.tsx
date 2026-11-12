import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { Command } from '@shared/protocol';
import { sampleContextGauge, sampleId } from '@shared/samples';
import { NotificationCenter } from '@web/shell/NotificationCenter';
import { SidePanelHost } from '@web/shell/side-panel/SidePanelHost';
import { resetSidePanelState } from '@web/shell/side-panel/state';
import type { FakeAck, FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { Composer } from '../composer/Composer';
import { getDraft, resetDraftStore, setDraft } from '../composer/state/drafts';
import { DecisionBar } from './DecisionBar';
import { DEMO_ENTRIES } from './lib/demo-data';
import { renderWithHost, type Harness } from './lib/testing';
import { readApproveMode, resetDecisionBarState } from './state/bar-store';
import { resetPlanData } from './state/plan-data';

// UI tests with many key strokes: 2.5–6 s in a full `pnpm test`, up to 21 s when several runs load
// the machine (docs/wp/FLAKES.md). A timed-out test keeps typing into the next one, so keep a margin.
vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  resetSidePanelState();
  resetDraftStore();
  resetPlanData();
  localStorage.clear();
});

function start(
  options: {
    panel?: boolean;
    composer?: boolean;
    notices?: boolean;
    onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  } = {},
): Harness {
  harness = renderWithHost(
    (key) => (
      <>
        {options.panel === false ? null : <SidePanelHost sessionKey={key('plan')} />}
        <DecisionBar sessionKey={key('plan')} />
        {options.composer === true ? <Composer sessionKey={key('plan')} /> : null}
        {options.notices === true ? <NotificationCenter /> : null}
      </>
    ),
    { entries: ['plan'], onCommand: options.onCommand },
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
    ['Manual – approve each change', 'Manual', 'default'],
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

  it('"With fresh context" in the ▾ menu: label, exact answer, remembered with the mode', async () => {
    const seen: Command[] = [];
    const h = start({
      onCommand: (cmd) => {
        seen.push(cmd);
        return undefined;
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'How should Claude implement the plan?' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'With auto mode' }));
    await user.click(await screen.findByRole('button', { name: 'How should Claude implement the plan?' }));
    const fresh = await screen.findByRole('menuitemcheckbox', { name: /With fresh context/ });
    expect(fresh.getAttribute('aria-checked')).toBe('false');
    await user.click(fresh);
    // The toggle keeps the menu open (the mode may be picked next).
    expect(
      screen.getByRole('menuitemcheckbox', { name: /With fresh context/ }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.keyboard('{Escape}');
    expect(approvals(h)).toEqual([]);
    const main = await screen.findByRole('button', { name: 'Implement · Auto · fresh context' });
    expect(main.dataset.fresh).toBe('true');
    await user.click(main);
    const respond = seen.filter((cmd) => cmd.name === 'decision.respond');
    expect(respond).toEqual([
      {
        name: 'decision.respond',
        entryId: DEMO_ENTRIES.plan,
        decisionId: sampleId('dc', 0xa41),
        response: {
          kind: 'plan',
          response: { behavior: 'approve_fresh_context', mode: 'auto', editedPlan: null },
        },
      },
    ]);
    await waitFor(() => {
      expect(localStorage.getItem('parallax.decisions.approveFresh')).toBe('true');
    });
    expect(readApproveMode()).toBe('auto');
  });

  it('starts from a remembered fresh choice; switching it off is remembered too', async () => {
    localStorage.setItem('parallax.decisions.approveMode', 'auto');
    localStorage.setItem('parallax.decisions.approveFresh', 'true');
    const h = start();
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'Implement · Auto · fresh context' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'How should Claude implement the plan?' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /With fresh context/ }));
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Implement · Auto' }));
    expect(approvals(h)).toEqual([
      { kind: 'plan', response: { behavior: 'approve', mode: 'auto', editedPlan: null } },
    ]);
    await waitFor(() => {
      expect(localStorage.getItem('parallax.decisions.approveFresh')).toBe('false');
    });
  });

  it('never remembers a bypass choice – neither the mode nor the fresh flag', async () => {
    localStorage.setItem('parallax.decisions.approveMode', 'acceptEdits');
    const h = start();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Implement · Accept edits' });
    const decision = h.host.view(DEMO_ENTRIES.plan)?.decisions[0];
    expect(decision?.kind).toBe('plan');
    if (decision?.kind !== 'plan') return;
    act(() => {
      h.host.pushOps(DEMO_ENTRIES.plan, [
        {
          op: 'decision.upsert',
          decision: { ...decision, approveModes: ['acceptEdits', 'bypassPermissions'] },
        },
      ]);
    });
    await user.click(screen.getByRole('button', { name: 'How should Claude implement the plan?' }));
    await user.click(
      await screen.findByRole('menuitemradio', { name: 'Without permission checks (bypass)' }),
    );
    await user.click(screen.getByRole('button', { name: 'How should Claude implement the plan?' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /With fresh context/ }));
    await user.keyboard('{Escape}');
    await user.click(
      await screen.findByRole('button', { name: 'Implement · Bypass permissions · fresh context' }),
    );
    expect(approvals(h)).toEqual([
      {
        kind: 'plan',
        response: { behavior: 'approve_fresh_context', mode: 'bypassPermissions', editedPlan: null },
      },
    ]);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Implement/ })).toBeNull();
    });
    expect(localStorage.getItem('parallax.decisions.approveMode')).toBe('acceptEdits');
    expect(localStorage.getItem('parallax.decisions.approveFresh')).toBeNull();
  });

  it.each([
    [59, false],
    [60, true],
  ] as const)(
    'at %i %% context "fresh context" is recommended: %s (never preselected)',
    async (percent, shown) => {
      const h = start();
      const user = userEvent.setup();
      await screen.findByRole('button', { name: 'Implement · Accept edits' });
      act(() => {
        h.host.patchSummary(DEMO_ENTRIES.plan, {
          context: sampleContextGauge({
            percentage: percent,
            totalTokens: percent * 2000,
            maxTokens: 200_000,
          }),
        });
      });
      await waitFor(() => {
        expect(screen.getByRole('meter', { name: 'Context' }).getAttribute('aria-valuenow')).toBe(
          String(percent),
        );
      });
      expect(document.querySelector('[data-slot="choice-menu-indicator"]') !== null).toBe(shown);
      await user.click(screen.getByRole('button', { name: 'How should Claude implement the plan?' }));
      const fresh = await screen.findByRole('menuitemcheckbox', { name: /With fresh context/ });
      expect(fresh.getAttribute('aria-checked')).toBe('false');
      const badge = within(fresh).queryByText('Recommended');
      expect(badge !== null).toBe(shown);
      if (shown) expect(fresh.textContent).toContain(`Context is ${String(percent)}% full.`);
      expect(screen.getByRole('button', { name: 'Implement · Accept edits' }).dataset.fresh).toBe('false');
    },
  );

  it.each([
    ['SESSION_BUSY', 'The session is busy. Try again in a moment.'],
    ['MODE_NOT_ALLOWED', 'This permission mode is not allowed for the profile.'],
  ] as const)('a %s answer to the fresh start shows in the card (role="alert")', async (code, text) => {
    localStorage.setItem('parallax.decisions.approveFresh', 'true');
    const h = start({
      onCommand: (cmd) =>
        cmd.name === 'decision.respond' ? { ok: false, error: makeError(code) } : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Implement · Accept edits · fresh context' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not implement with a fresh context');
    expect(alert.textContent).toContain(text);
    // The card stays answerable; nothing was remembered.
    expect(screen.getByRole('button', { name: 'Implement · Accept edits · fresh context' })).toBeTruthy();
    expect(localStorage.getItem('parallax.decisions.approveMode')).toBeNull();
    expect(approvals(h)).toHaveLength(1);
    // Changing the choice clears the error.
    await user.click(screen.getByRole('button', { name: 'How should Claude implement the plan?' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /With fresh context/ }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('a start error after the decision closed becomes a notice (the card is gone)', async () => {
    localStorage.setItem('parallax.decisions.approveFresh', 'true');
    start({
      notices: true,
      onCommand: (cmd, host) => {
        if (cmd.name !== 'decision.respond') return undefined;
        host.pushOps(cmd.entryId, [
          {
            op: 'decision.resolved',
            decisionId: cmd.decisionId,
            outcome: { type: 'plan_approved', mode: 'acceptEdits', edited: false, freshContext: true },
            byClientId: null,
            at: host.now(),
          },
        ]);
        host.syncDecisionCounts(cmd.entryId);
        return { ok: false, error: makeError('CLAUDE_STARTUP_FAILED') };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Implement · Accept edits · fresh context' }));
    expect(await screen.findByText('Claude Code failed to start.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Implement/ })).toBeNull();
    expect(document.querySelector('[data-slot="fresh-context-error"]')).toBeNull();
  });

  it('"Keep planning" without text moves the focus into the composer', async () => {
    const h = start({ composer: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Keep planning' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message to Claude' }));
    expect(approvals(h)).toEqual([]);
  });

  it('"Keep planning" with a draft sends the composer text as revise feedback – its label stays', async () => {
    const h = start({ composer: true });
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Message to Claude' }), 'Add tests first');
    // R2W-16: the bar keeps "Keep planning" (fixed width), "…with feedback" is the composer's.
    const fromBar = screen.getByRole('button', { name: 'Keep planning' });
    expect(fromBar.dataset.action).toBe('revise');
    expect(screen.getAllByRole('button', { name: 'Keep planning with feedback' })).toHaveLength(1);
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
    const panel = await screen.findByRole('complementary', { name: 'Plan' });
    // The panel's content is a lazy chunk: in a busy full run it may still show its loading state.
    expect(await within(panel).findByRole('heading', { name: 'Plan v2' })).toBeTruthy();
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
    await user.click(screen.getByRole('button', { name: 'Keep planning' }));
    const panel = screen.getByRole('complementary');
    await waitFor(() => {
      expect(panel.querySelector('[data-slot="plan-status"]')?.textContent).toBe('Rejected with feedback');
    });
    expect(panel.textContent).toContain('## Risks');
    expect(within(panel).getByRole('heading', { name: 'Plan v2' })).toBeTruthy();
  });

  it('without a mounted side panel the plan opens inside the card', async () => {
    start({ panel: false });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open plan' }));
    expect(document.querySelector('[data-slot="plan-inline"]')?.textContent).toContain('## Tests');
  });
});
