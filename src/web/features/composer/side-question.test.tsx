import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { setLanguage } from '@web/i18n';
import { requestShell } from '@web/shell/requests';
import { clientStore, resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES, type DemoEntry } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { resetDecisionBarState } from '../decisions/state/bar-store';
import { Composer } from './Composer';
import { resetAttachments } from './state/attachments';
import { resetDraftStore } from './state/drafts';

/**
 * WP-66 in the composer: side mode (toggle next to Send, one question, Esc leaves it, also while
 * Claude works), `/btw`, a refused side question comes back, and „Zurückholen“ puts a waiting
 * message's text back into the field (shell request `composerText`).
 */

vi.setConfig({ testTimeout: 60_000 });

let harness: Harness | null = null;

afterEach(() => {
  harness?.stop();
  harness = null;
  resetClientStore();
  resetDecisionBarState();
  resetDraftStore();
  resetAttachments();
  localStorage.clear();
  act(() => {
    setLanguage('en');
  });
});

type OnCommand = Parameters<typeof renderWithHost>[1]['onCommand'];

async function start(entry: DemoEntry = 'idle', onCommand?: OnCommand): Promise<Harness> {
  const h = renderWithHost((key) => <Composer sessionKey={key(entry)} />, { entries: [entry], onCommand });
  harness = h;
  await screen.findByRole('button', { name: 'Model: Haiku' });
  return h;
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Claude' });
}

function toggle(): HTMLElement {
  return screen.getByRole('button', { name: 'Side question (not part of the conversation)' });
}

function composerMode(): string | undefined {
  return document.querySelector<HTMLElement>('[data-slot="composer"]')?.dataset.mode;
}

describe('side mode (WP-66 §1.2)', () => {
  it('the toggle: side placeholder and border, Enter asks once, then the field is normal again', async () => {
    const h = await start();
    const user = userEvent.setup();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(composerMode()).toBe('side');
    expect(textbox().getAttribute('placeholder')).toBe('Side question – does not go into the context…');
    expect(textbox().dataset.side).toBe('true');
    expect(document.activeElement).toBe(textbox());
    // No attachments in side mode (the paper clip is gone).
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    await user.type(textbox(), 'Why this approach?');
    expect(screen.getByRole('button', { name: 'Ask' })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(h.commands('session.askSideQuestion')).toEqual([
      {
        name: 'session.askSideQuestion',
        entryId: DEMO_ENTRIES.idle,
        question: 'Why this approach?',
        threadId: null,
      },
    ]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
    expect(textbox().value).toBe('');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(composerMode()).toBe('idle');
  });

  it('while Claude works: no "Send now", the turn keeps running; Esc leaves side mode and keeps the text', async () => {
    const h = await start('working');
    const user = userEvent.setup();
    await user.click(toggle());
    await user.type(textbox(), 'Status?');
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(textbox().value).toBe('Status?');
    expect(composerMode()).toBe('queue');
    expect(h.commands('session.interrupt')).toEqual([]);
    await user.click(toggle());
    await user.keyboard('{Enter}');
    expect(h.commands('session.askSideQuestion').map((cmd) => cmd.question)).toEqual(['Status?']);
    expect(h.commands('session.interrupt')).toEqual([]);
    expect(h.commands('session.sendPrompt')).toEqual([]);
  });

  it('a large paste stays text in side mode (no chip)', async () => {
    await start();
    await userEvent.setup().click(toggle());
    const big = 'y'.repeat(2500);
    const inserted = fireEvent.paste(textbox(), {
      clipboardData: { items: [], files: [], types: ['text/plain'], getData: () => big },
    });
    expect(inserted).toBe(true);
  });

  it('refused (e.g. archived meanwhile): text and side mode come back with a notice', async () => {
    const h = await start('idle', (cmd) =>
      cmd.name === 'session.askSideQuestion'
        ? { ok: false, error: makeError('SESSION_ARCHIVED') }
        : undefined,
    );
    const user = userEvent.setup();
    await user.click(toggle());
    await user.type(textbox(), 'Why?{Enter}');
    await waitFor(() => {
      expect(textbox().value).toBe('Why?');
    });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(h.commands('session.askSideQuestion')).toHaveLength(1);
    expect(clientStore.getState().notices.map((notice) => notice.tone)).toEqual(['error']);
  });

  it('German texts', async () => {
    await start();
    act(() => {
      setLanguage('de');
    });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Seitenfrage (nicht Teil der Unterhaltung)' }));
    expect(document.querySelector('textarea')?.getAttribute('placeholder')).toBe(
      'Seitenfrage – geht nicht in den Kontext…',
    );
  });
});

describe('/btw (WP-66)', () => {
  it('/btw <question> asks right away; /btw alone switches side mode on', async () => {
    const h = await start();
    const user = userEvent.setup();
    await user.type(textbox(), '/btw What did you change?');
    await user.keyboard('{Escape}{Enter}');
    await waitFor(() => {
      expect(h.commands('session.askSideQuestion').map((cmd) => cmd.question)).toEqual([
        'What did you change?',
      ]);
    });
    await waitFor(() => {
      expect(textbox().value).toBe('');
    });
    expect(h.commands('session.sendPrompt')).toEqual([]);

    await user.type(textbox(), '/btw');
    await user.keyboard('{Escape}{Enter}');
    await waitFor(() => {
      expect(toggle().getAttribute('aria-pressed')).toBe('true');
    });
    expect(textbox().value).toBe('');
    expect(h.commands('session.askSideQuestion')).toHaveLength(1);
  });
});

describe('„Zurückholen“ into the field (shell request composerText)', () => {
  it('fills an empty field, appends to a draft as a new paragraph; another session is not taken', async () => {
    const h = await start();
    const key = h.key('idle');
    let taken = false;
    act(() => {
      taken = requestShell({ kind: 'composerText', sessionKey: key, text: 'First message' });
    });
    expect(taken).toBe(true);
    expect(textbox().value).toBe('First message');
    expect(document.activeElement).toBe(textbox());
    act(() => {
      requestShell({ kind: 'composerText', sessionKey: key, text: 'Second message' });
    });
    expect(textbox().value).toBe('First message\n\nSecond message');
    act(() => {
      taken = requestShell({ kind: 'composerText', sessionKey: h.key('working'), text: 'elsewhere' });
    });
    expect(taken).toBe(false);
  });
});
