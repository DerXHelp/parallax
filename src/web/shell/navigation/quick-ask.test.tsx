/**
 * WP-66 "Quick question…" in the sidebar: the context-menu entry (disabled for archived and
 * external sessions), the popover at the row (side question, answer, follow-up in the same thread,
 * "Open session"), refusals inside the popover, and the notice when it was closed before the answer.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import type { SideQuestionItem } from '@shared/model';
import { sampleSummary, sampleTime } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { PLAYGROUND_ENTRIES, PLAYGROUND_SESSION_KEYS } from '@web/playground/scenarios';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { getSelectedSession } from '@web/state/selection';
import { clientStore, resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { installShortcutListener } from '../shortcuts';
import { closeQuickAsk } from './quick-ask';
import { resetRename } from './rename';
import { SIDEBAR_ACTIONS, sessionActions } from './session-actions';
import { resetSidebarView } from './sidebar-view';

vi.setConfig({ testTimeout: 60_000 });

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => {
    closeQuickAsk();
    resetRename();
    resetSidebarView();
    setLanguage('en');
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
});

const KEY = PLAYGROUND_SESSION_KEYS.main;
const ENTRY = PLAYGROUND_ENTRIES.main;

function row(): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-session-row="${KEY}"]`);
  if (element === null) throw new Error('no row');
  return element;
}

function scenario(): RunningScenario {
  if (running === null) throw new Error('no scenario');
  return running;
}

async function openPopover(): Promise<HTMLElement> {
  running = startScenario('overview');
  cleanups.push(installShortcutListener());
  render(<AppShell />);
  const nav = await screen.findByRole('navigation', { name: 'Sessions' });
  await within(nav).findByText('Sample session');
  fireEvent.contextMenu(row());
  const menu = await screen.findByRole('menu');
  await userEvent.setup().click(within(menu).getByRole('menuitem', { name: 'Quick question…' }));
  return screen.findByRole('dialog', { name: 'Quick question · Sample session' });
}

function sideItems(): SideQuestionItem[] {
  const view = clientStore.getState().sessions[KEY]?.view;
  return (view?.items ?? []).filter((item): item is SideQuestionItem => item.kind === 'side_question');
}

describe('the menu entry (WP-66)', () => {
  it('first in the sidebar menus; disabled for archived and external sessions', () => {
    expect(SIDEBAR_ACTIONS[0]).toBe('quickAsk');
    const first = (summary = sampleSummary()) => sessionActions(SIDEBAR_ACTIONS, KEY, summary, 'sidebar')[0];
    expect(first()).toMatchObject({ id: 'quickAsk', label: 'navigation.actions.quickAsk', disabled: false });
    expect(first(sampleSummary({ archived: true }))?.disabled).toBe(true);
    expect(
      first(sampleSummary({ external: { since: sampleTime(1), pid: null, running: true } }))?.disabled,
    ).toBe(true);
  });
});

describe('the popover (WP-66 §1.2)', () => {
  it('asks, shows the answer, follows up in the same thread; "Open session" selects it', async () => {
    const popover = await openPopover();
    const user = userEvent.setup();
    expect(
      within(popover).getByText('Answered from the conversation – does not go into the context.'),
    ).toBeTruthy();
    const field = within(popover).getByRole('textbox', { name: 'Ask about this session…' });
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
    await user.type(field, 'What is left to do?{Enter}');
    expect(scenario().host.commands).toContainEqual({
      name: 'session.askSideQuestion',
      entryId: ENTRY,
      question: 'What is left to do?',
      threadId: null,
    });
    expect(await within(popover).findByText('asking…')).toBeTruthy();
    expect(
      await within(popover).findByText(
        'A playground side answer to “What is left to do?”. No model was called.',
      ),
    ).toBeTruthy();
    const first = sideItems()[0];
    if (first === undefined) throw new Error('no side question');

    await user.type(within(popover).getByRole('textbox', { name: 'Follow up…' }), 'And after that?{Enter}');
    await waitFor(() => {
      expect(scenario().host.commands).toContainEqual({
        name: 'session.askSideQuestion',
        entryId: ENTRY,
        question: 'And after that?',
        threadId: first.id,
      });
    });

    await user.click(within(popover).getByRole('button', { name: 'Open session' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(getSelectedSession()).toBe(KEY);
  });

  it('a refusal shows in the popover; busy has its own words', async () => {
    const popover = await openPopover();
    scenario().host.failNext('session.askSideQuestion', makeError('SESSION_BUSY'));
    await userEvent.setup().type(within(popover).getByRole('textbox'), 'Why?{Enter}');
    const alert = await within(popover).findByRole('alert');
    expect(alert.textContent).toContain('Too many side questions right now – try again in a moment');
  });

  it('closed before the answer: the answer comes as a notice of the session', async () => {
    const popover = await openPopover();
    const user = userEvent.setup();
    await user.type(within(popover).getByRole('textbox'), 'Quick status?{Enter}');
    await within(popover).findByText('asking…');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(clientStore.getState().notices).toContainEqual(
        expect.objectContaining({
          sessionKey: KEY,
          content: {
            text: 'navigation.quickAsk.answered',
            params: {
              title: 'Sample session',
              answer: 'A playground side answer to “Quick status?”. No model was called.',
            },
          },
        }),
      );
    });
  });
});
