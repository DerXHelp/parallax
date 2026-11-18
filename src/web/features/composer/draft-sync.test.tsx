import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { Draft } from '@shared/model';
import { sampleDraft, sampleId } from '@shared/samples';
import { resetClientStore } from '@web/state/store';
import { DEMO_ENTRIES } from '../decisions/lib/demo-data';
import { renderWithHost, type Harness } from '../decisions/lib/testing';
import { Composer } from './Composer';
import { draftSyncStorageKey, keepDraftThroughSend } from './state/draft-sync';
import { draftStorageKey, resetDraftStore } from './state/drafts';

vi.setConfig({ testTimeout: 60_000 });

const ENTRY = DEMO_ENTRIES.idle;
const SESSION_KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
const OTHER_WINDOW = sampleId('cl', 7);

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

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(i + 1)}`).join('\n');
}

function pasteText(text: string): void {
  fireEvent.paste(textbox(), {
    clipboardData: {
      items: [],
      files: [],
      types: ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
}

async function expectChips(count: number): Promise<void> {
  await waitFor(() => {
    const list = screen.queryByRole('list', { name: 'Pasted texts' });
    expect(list === null ? 0 : within(list).getAllByRole('listitem').length).toBe(count);
  });
}

/** The server's draft (fake host view). */
function serverDraft(h: Harness): Draft | null {
  return h.host.view(ENTRY)?.detail.draft ?? null;
}

/** Waits until the field is connected and has looked at the view (first sight done). */
async function ready(h: Harness): Promise<void> {
  await waitFor(() => {
    expect(h.host.subscribed.has(ENTRY)).toBe(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A draft written by another window. */
function foreign(h: Harness, draft: Partial<Draft>): void {
  act(() => {
    h.host.pushOps(ENTRY, [
      { op: 'detail.patch', patch: { draft: sampleDraft({ clientId: OTHER_WINDOW, ...draft }) } },
    ]);
  });
}

async function quiet(ms = 600): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('draft sync (WP-77, ADR-210)', () => {
  it('sends the field about 400 ms after typing; the own echo changes nothing', async () => {
    const h = start();
    await ready(h);
    const user = userEvent.setup();
    await user.type(textbox(), 'Hello there');
    expect(h.commands('session.setDraft')).toEqual([]);
    await waitFor(() => {
      expect(h.commands('session.setDraft')).toHaveLength(1);
    });
    expect(h.commands('session.setDraft')[0]).toMatchObject({
      entryId: ENTRY,
      draft: { text: 'Hello there', pastes: [] },
      baseRev: null,
    });
    expect(serverDraft(h)).toMatchObject({ text: 'Hello there', rev: 1 });
    expect(h.host.summaries.get(ENTRY)?.hasDraft).toBe(true);
    await quiet();
    expect(textbox().value).toBe('Hello there');
    expect(h.commands('session.setDraft')).toHaveLength(1);
    expect(localStorage.getItem(draftSyncStorageKey(h.key('idle')))).toBe('clean');
  });

  it('takes a foreign draft over while the field is unchanged – paste chips come back', async () => {
    const h = start();
    await ready(h);
    const log = lines(40, 'log');
    foreign(h, { text: `see ${log}\nplease`, pastes: [log], rev: 3 });
    await waitFor(() => {
      expect(textbox().value).toBe('see [#1 · 40 lines]\nplease');
    });
    await expectChips(1);
    await quiet();
    expect(h.commands('session.setDraft')).toEqual([]);
    // A cleared draft (sent from the other window) empties the field.
    foreign(h, { text: 'next', rev: 4 });
    await waitFor(() => {
      expect(textbox().value).toBe('next');
    });
    act(() => {
      h.host.pushOps(ENTRY, [{ op: 'detail.patch', patch: { draft: null } }]);
    });
    await waitFor(() => {
      expect(textbox().value).toBe('');
    });
    await expectChips(0);
  });

  it('an own edit beats a foreign draft (the last writer wins)', async () => {
    const h = start();
    await ready(h);
    const user = userEvent.setup();
    await user.type(textbox(), 'mine');
    foreign(h, { text: 'theirs', rev: 5 });
    await quiet(50);
    expect(textbox().value).toBe('mine');
    await waitFor(() => {
      expect(serverDraft(h)).toMatchObject({ text: 'mine', rev: 6 });
    });
    expect(h.commands('session.setDraft').at(-1)).toMatchObject({ draft: { text: 'mine' }, baseRev: null });
    await quiet();
    expect(textbox().value).toBe('mine');
  });

  it('paste chips round trip: tokens replaced on the way out, rebuilt in another window', async () => {
    const h = start();
    await ready(h);
    const user = userEvent.setup();
    const log = lines(35, 'log');
    await user.type(textbox(), 'Check ');
    pasteText(log);
    await user.keyboard(' thanks');
    expect(textbox().value).toBe('Check [#1 · 35 lines] thanks');
    await waitFor(() => {
      expect(serverDraft(h)?.pastes).toEqual([log]);
    });
    const sent = serverDraft(h);
    expect(sent?.text).toBe(`Check ${log}\nthanks`);
    if (sent === null) throw new Error('no draft');
    h.stop();
    resetClientStore();
    resetDraftStore();
    localStorage.clear();

    // The other window: same session, the server holds the draft.
    const other = start();
    await ready(other);
    foreign(other, { ...sent, clientId: OTHER_WINDOW });
    await waitFor(() => {
      expect(textbox().value).toBe('Check [#1 · 35 lines]\nthanks');
    });
    await expectChips(1);
    await quiet();
    expect(other.commands('session.setDraft')).toEqual([]);
  });

  it('migration: a draft stored before WP-77 goes to the server once', async () => {
    const sessionKey = SESSION_KEY;
    localStorage.setItem(draftStorageKey(sessionKey), 'written before the update');
    const h = start();
    expect(h.key('idle')).toBe(sessionKey);
    await waitFor(() => {
      expect(serverDraft(h)).toMatchObject({ text: 'written before the update' });
    });
    await quiet();
    expect(h.commands('session.setDraft')).toHaveLength(1);
    expect(textbox().value).toBe('written before the update');
  });

  it('a confirmed draft the server no longer has was sent elsewhere: the field empties', async () => {
    const sessionKey = SESSION_KEY;
    localStorage.setItem(draftStorageKey(sessionKey), 'sent from another window');
    localStorage.setItem(draftSyncStorageKey(sessionKey), 'clean');
    const h = start();
    await waitFor(() => {
      expect(textbox().value).toBe('');
    });
    await quiet();
    expect(h.commands('session.setDraft')).toEqual([]);
  });

  it('unconfirmed edits after a reload go to the server', async () => {
    const sessionKey = SESSION_KEY;
    localStorage.setItem(draftStorageKey(sessionKey), 'typed offline');
    localStorage.setItem(draftSyncStorageKey(sessionKey), 'dirty');
    const h = start();
    await waitFor(() => {
      expect(serverDraft(h)).toMatchObject({ text: 'typed offline' });
    });
    expect(localStorage.getItem(draftSyncStorageKey(sessionKey))).toBe('clean');
  });

  it('errors never disturb typing: the draft stays local and goes with the next edit', async () => {
    const h = start();
    await ready(h);
    h.host.failNext('session.setDraft', makeError('DRAFT_TOO_LARGE', { chars: 1, max: 0 }));
    const user = userEvent.setup();
    await user.type(textbox(), 'abc');
    await waitFor(() => {
      expect(h.commands('session.setDraft')).toHaveLength(1);
    });
    await quiet(50);
    expect(textbox().value).toBe('abc');
    expect(serverDraft(h)).toBeNull();
    expect(localStorage.getItem(draftSyncStorageKey(h.key('idle')))).toBe('dirty');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.type(textbox(), 'd');
    await waitFor(() => {
      expect(serverDraft(h)).toMatchObject({ text: 'abcd' });
    });
    expect(textbox().value).toBe('abcd');
  });

  it('an older server without session.setDraft: one try, then the draft stays local', async () => {
    harness = renderWithHost((key) => <Composer sessionKey={key('idle')} />, {
      entries: ['idle'],
      onCommand: (cmd) =>
        cmd.name === 'session.setDraft'
          ? { ok: false, error: makeError('NOT_IMPLEMENTED', { command: cmd.name }) }
          : undefined,
    });
    const h = harness;
    await ready(h);
    const user = userEvent.setup();
    await user.type(textbox(), 'a');
    await waitFor(() => {
      expect(h.commands('session.setDraft')).toHaveLength(1);
    });
    await user.type(textbox(), 'b');
    await quiet();
    expect(h.commands('session.setDraft')).toHaveLength(1);
    expect(textbox().value).toBe('ab');
  });

  it('sending clears the field and the server draft', async () => {
    const h = start();
    await ready(h);
    const user = userEvent.setup();
    await user.type(textbox(), 'Do it');
    await waitFor(() => {
      expect(serverDraft(h)).not.toBeNull();
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(h.commands('session.sendPrompt')).toHaveLength(1);
    });
    expect(textbox().value).toBe('');
    await waitFor(() => {
      expect(serverDraft(h)).toBeNull();
    });
    expect(h.host.summaries.get(ENTRY)?.hasDraft).toBe(false);
  });

  it('keepDraftThroughSend sends the field again at once (a prompt that is not the draft)', async () => {
    const h = start();
    await ready(h);
    const user = userEvent.setup();
    await user.type(textbox(), 'half');
    await waitFor(() => {
      expect(serverDraft(h)?.rev).toBe(1);
    });
    act(() => {
      keepDraftThroughSend(h.key('idle'));
    });
    await waitFor(
      () => {
        expect(serverDraft(h)).toMatchObject({ text: 'half', rev: 2 });
      },
      { timeout: 300 },
    );
    expect(textbox().value).toBe('half');
  });
});
