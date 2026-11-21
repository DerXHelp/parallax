import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestShell } from '@web/shell/requests';
import { resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
import { DRAFT_PASTES_MAX_CHARS } from './lib/pastes';
import { resetDraftStore } from './state/drafts';

/**
 * WP-114: the composer while a worktree is prepared (nothing goes out, a hint says why) and a text
 * from outside as a paste chip (`composerText {asPaste: true}`, the review package of ADR-254).
 */

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDraftStore();
  localStorage.clear();
});

function start(): Harness {
  harness = renderWithHost((key) => <Composer sessionKey={key('idle')} />, { entries: ['idle'] });
  return harness;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

function setupHint(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="composer-worktree-setup"]');
}

function pasteChips(): HTMLElement[] {
  const list = screen.queryByRole('list', { name: 'Pasted texts' });
  return list === null ? [] : within(list).getAllByRole('listitem');
}

describe('composer while the worktree is prepared (WP-114)', () => {
  it('creating/setup: Send is disabled, Enter sends nothing, the hint describes the field; failed sends again', async () => {
    const h = start();
    const entryId = DEMO_ENTRIES.idle;
    const user = userEvent.setup();
    act(() => {
      h.host.patchSummary(entryId, {
        worktreeSetup: { state: 'creating', exitCode: null, terminalId: null },
      });
    });
    await waitFor(() => {
      expect(setupHint()?.dataset.state).toBe('creating');
    });
    expect(setupHint()?.textContent).toBe('The worktree is being created – you can send once it is ready.');
    expect(textbox().getAttribute('aria-describedby')).toContain(setupHint()?.id ?? '-');

    await user.type(textbox(), 'Hello{Enter}');
    expect(h.commands('session.sendPrompt')).toHaveLength(0);
    expect(textbox().value).toBe('Hello');
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);

    act(() => {
      h.host.patchSummary(entryId, { worktreeSetup: { state: 'setup', exitCode: null, terminalId: null } });
    });
    await waitFor(() => {
      expect(setupHint()?.textContent).toBe(
        'The project’s setup command is running – you can send once it is done.',
      );
    });

    act(() => {
      h.host.patchSummary(entryId, { worktreeSetup: { state: 'failed', exitCode: 1, terminalId: null } });
    });
    await waitFor(() => {
      expect(setupHint()).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(h.commands('session.sendPrompt')).toHaveLength(1);
    });
  });
});

describe('composerText {asPaste: true} (WP-114)', () => {
  it('becomes a token + chip at the end of the draft, whatever its size; without asPaste it stays text', async () => {
    const h = start();
    const key = h.key('idle');
    const user = userEvent.setup();
    await user.type(textbox(), 'Please look at this:');
    let taken = false;
    act(() => {
      taken = requestShell({
        kind: 'composerText',
        sessionKey: key,
        text: 'diff --git a/x b/x\n+one\n+two',
        asPaste: true,
      });
    });
    expect(taken).toBe(true);
    expect(textbox().value).toBe('Please look at this:\n\n[#1 · 3 lines]');
    expect(document.activeElement).toBe(textbox());
    await waitFor(() => {
      expect(pasteChips()).toHaveLength(1);
    });
    act(() => {
      requestShell({ kind: 'composerText', sessionKey: key, text: 'plain' });
    });
    expect(textbox().value).toBe('Please look at this:\n\n[#1 · 3 lines]\n\nplain');
    expect(pasteChips()).toHaveLength(1);
  });

  it('a refused paste (draft too large) goes into the field as text; another session is not taken', () => {
    const h = start();
    const key = h.key('idle');
    const huge = 'x'.repeat(DRAFT_PASTES_MAX_CHARS + 1);
    act(() => {
      requestShell({ kind: 'composerText', sessionKey: key, text: huge, asPaste: true });
    });
    expect(textbox().value).toBe(huge);
    expect(pasteChips()).toHaveLength(0);
    let taken = true;
    act(() => {
      taken = requestShell({
        kind: 'composerText',
        sessionKey: h.key('working'),
        text: 'elsewhere',
        asPaste: true,
      });
    });
    expect(taken).toBe(false);
  });
});
