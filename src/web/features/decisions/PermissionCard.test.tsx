import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RULE_DESTINATIONS } from '@shared/common';
import { makeError } from '@shared/errors';
import { clientStore, resetClientStore } from '@web/state/store';
import { resetDraftStore } from '../composer/state/drafts';
import { DecisionBar } from './DecisionBar';
import { renderWithHost, type Harness } from './lib/testing';
import { resetDecisionBarState } from './state/bar-store';

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

function bar(
  entry: 'permission' | 'edit' | 'cautious',
  options: Parameters<typeof renderWithHost>[1] = { entries: [entry] },
) {
  harness = renderWithHost((key) => <DecisionBar sessionKey={key(entry)} />, options);
  return harness;
}

function card(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-decision-id]');
  if (element === null) throw new Error('no decision card');
  return element;
}

function responses(h: Harness) {
  return h.commands('decision.respond').map((cmd) => cmd.response);
}

describe('PermissionCard', () => {
  it('shows tool, input summary and who asks', async () => {
    bar('permission');
    expect(await screen.findByText('Bash needs your permission')).toBeTruthy();
    expect(screen.getByText('pnpm install --frozen-lockfile')).toBeTruthy();
    expect(screen.getByText('Main agent')).toBeTruthy();
  });

  it('answer buttons describe why Enter does nothing (screen readers, R2W-19)', async () => {
    bar('permission');
    expect(
      await screen.findByRole('button', {
        name: 'Allow once',
        description: 'Click or press Ctrl+Enter – Enter and Space never answer.',
      }),
    ).toBeTruthy();
  });

  it('"Allow once" sends the intent only (no remember, no accept edits) and the card goes away', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Allow once' }));
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'allow', remember: null, acceptEdits: false } },
    ]);
    await waitFor(() => {
      expect(document.querySelector('[data-decision-id]')).toBeNull();
    });
  });

  it('"Always allow" defaults to the session and offers all four destinations (ADR-012)', async () => {
    for (const destination of RULE_DESTINATIONS) {
      const h = bar('permission');
      const user = userEvent.setup();
      await screen.findByRole('button', { name: 'Always allow · This session' });
      if (destination !== 'session') {
        await user.click(screen.getByRole('button', { name: 'Where should the rule be remembered?' }));
        const label = {
          localSettings: 'This project (local)',
          projectSettings: 'This project (shared)',
          userSettings: 'All projects (global)',
        }[destination];
        const item = await screen.findByRole('menuitemradio', {
          name: new RegExp(label.replace(/[()]/g, '\\$&')),
        });
        if (destination === 'projectSettings') expect(within(item).getByText('Writes to repo')).toBeTruthy();
        if (destination === 'userSettings') expect(within(item).getByText('Global')).toBeTruthy();
        await user.click(item);
        await screen.findByRole('button', { name: `Always allow · ${label}` });
      }
      await user.click(screen.getByRole('button', { name: /^Always allow/ }));
      expect(responses(h)).toEqual([
        { kind: 'permission', response: { behavior: 'allow', remember: destination, acceptEdits: false } },
      ]);
      harness?.stop();
      harness = null;
      resetClientStore();
      resetDecisionBarState();
    }
  });

  it('marks project and user destinations next to the button', async () => {
    bar('permission');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Where should the rule be remembered?' }));
    await user.click(await screen.findByRole('menuitemradio', { name: /All projects \(global\)/ }));
    const region = screen.getByRole('region', { name: 'Decisions' });
    expect(within(region).getByText('Global')).toBeTruthy();
  });

  it('"Allow + accept edits" is its own explicit option', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Allow + accept edits' }));
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'allow', remember: null, acceptEdits: true } },
    ]);
  });

  it('denies plainly, with a reason, or with interrupt', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More ways to deny' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deny with a reason…' }));
    const reason = await screen.findByRole('textbox', { name: 'Reason for Claude' });
    expect(document.activeElement).toBe(reason);
    await user.type(reason, 'Use pnpm i instead');
    await user.click(screen.getByRole('button', { name: 'Send denial' }));
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'Use pnpm i instead', interrupt: false } },
    ]);
  });

  it('"Deny and stop the turn…" opens a form; its button sends interrupt: true', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More ways to deny' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deny and stop the turn…' }));
    expect(responses(h)).toEqual([]);
    const reason = await screen.findByRole('textbox', { name: 'Reason for Claude (optional)' });
    expect(document.activeElement).toBe(reason);
    expect(screen.getByText('Stops the whole turn – background subagents end too.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Deny and stop' }));
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: '', interrupt: true } },
    ]);
  });

  it('Enter on a deny menu item never answers (R2W-05) – Mod+Enter in the form does', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'More ways to deny' });
    act(() => {
      trigger.focus();
    });
    await user.keyboard('{Enter}');
    const item = await screen.findByRole('menuitem', { name: 'Deny and stop the turn…' });
    act(() => {
      item.focus();
    });
    await user.keyboard('{Enter}');
    expect(responses(h)).toEqual([]);
    await user.type(
      await screen.findByRole('textbox', { name: 'Reason for Claude (optional)' }),
      'wrong repo',
    );
    await user.keyboard('{Enter}');
    expect(responses(h)).toEqual([]);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: 'wrong repo', interrupt: true } },
    ]);
  });

  it('hides "always" without destinations and makes deny the main action with defaultToNo', async () => {
    const h = bar('cautious');
    const user = userEvent.setup();
    await screen.findByText('Claude Code suggests denying this request.');
    expect(screen.queryByRole('button', { name: /^Always allow/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow + accept edits' })).toBeNull();
    expect(screen.getByText(/Outside the allowed folders/)).toBeTruthy();
    act(() => {
      card().focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'deny', message: '', interrupt: false } },
    ]);
  });

  it('shows the change preview of Edit through the ToolInputPreview slot, open by default', async () => {
    bar('edit');
    expect(await screen.findByTestId('tool-input-preview')).toBeTruthy();
    expect(screen.getByTestId('tool-input-preview').textContent).toBe('Edit');
    expect(screen.queryByRole('button', { name: /^Always allow/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow + accept edits' })).toBeTruthy();
  });
});

describe('answer safety (Plan "Tippen kann nie freigeben")', () => {
  it('Enter, Space or typing on a focused answer button never answers', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    const allow = await screen.findByRole('button', { name: 'Allow once' });
    act(() => {
      allow.focus();
    });
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('yes please{Enter}');
    expect(responses(h)).toEqual([]);
    expect(document.querySelector('[data-decision-id]')).not.toBeNull();
  });

  it('Mod+Enter answers with the focused answer button while the bar has the focus', async () => {
    const h = bar('permission');
    const user = userEvent.setup();
    const always = await screen.findByRole('button', { name: 'Always allow · This session' });
    act(() => {
      always.focus();
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(responses(h)).toEqual([
      { kind: 'permission', response: { behavior: 'allow', remember: 'session', acceptEdits: false } },
    ]);
  });

  it('Mod+Enter outside the bar does nothing', async () => {
    const h = renderWithHost(
      (key) => (
        <>
          <textarea aria-label="elsewhere" />
          <DecisionBar sessionKey={key('permission')} />
        </>
      ),
      { entries: ['permission'] },
    );
    harness = h;
    const user = userEvent.setup();
    await screen.findByRole('button', { name: 'Allow once' });
    await user.click(screen.getByRole('textbox', { name: 'elsewhere' }));
    await user.keyboard('ok{Control>}{Enter}{/Control}');
    expect(responses(h)).toEqual([]);
  });

  it('a new decision ignores clicks during the arm delay', async () => {
    const h = bar('permission', { entries: ['permission'], armDelayMs: 150 });
    const user = userEvent.setup();
    const allow = await screen.findByRole('button', { name: 'Allow once' });
    expect(card().dataset.armed).toBe('false');
    await user.click(allow);
    expect(responses(h)).toEqual([]);
    await waitFor(() => {
      expect(card().dataset.armed).toBe('true');
    });
    await user.click(allow);
    expect(responses(h)).toHaveLength(1);
  });

  it('never takes the focus when a decision arrives', async () => {
    harness = renderWithHost(
      (key) => (
        <>
          <textarea aria-label="typing here" />
          <DecisionBar sessionKey={key('permission')} />
        </>
      ),
      { entries: ['permission'] },
    );
    const typing = screen.getByRole('textbox', { name: 'typing here' });
    act(() => {
      typing.focus();
    });
    await screen.findByRole('button', { name: 'Allow once' });
    expect(document.activeElement).toBe(typing);
    expect(card().getAttribute('role')).toBeNull();
  });

  it('shows DECISION_ALREADY_RESOLVED (first click wins) as a notice and re-enables the card', async () => {
    harness = renderWithHost((key) => <DecisionBar sessionKey={key('permission')} />, {
      entries: ['permission'],
      onCommand: (cmd) =>
        cmd.name === 'decision.respond'
          ? { ok: false, error: makeError('DECISION_ALREADY_RESOLVED') }
          : undefined,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Allow once' }));
    await waitFor(() => {
      expect(clientStore.getState().notices.map((notice) => notice.content)).toEqual([
        { error: makeError('DECISION_ALREADY_RESOLVED') },
      ]);
    });
    expect(clientStore.getState().notices[0]?.tone).toBe('info');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(false);
    });
  });
});
