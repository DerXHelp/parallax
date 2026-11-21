import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { HostState } from '@shared/model';
import type { Command, CommandOf } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleHostState,
  sampleId,
  sampleSearchHit,
  sampleSummary,
  sampleTime,
  sampleWorktreeRef,
} from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { resetSidebarView } from '@web/shell/navigation/sidebar-view';
import { registerShellRequestHandler, requestShell, type ShellRequestOf } from '@web/shell/requests';
import { installShortcutListener } from '@web/shell/shortcuts';
import { createHostConnection, registerConnection, unregisterConnection } from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { selectSummaryEntries } from '@web/state/hooks';
import { clientStore, resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { TooltipProvider } from '@web/ui/tooltip';
import { SEARCH_SLOTS } from './index';
import { cancelPendingReveal } from './lib/reveal';
import { resetSearchMemory } from './SearchDialog';

/**
 * WP-115 – the search dialog: `search.open` and Ctrl+Shift+F only with a computer that searches
 * contents, the query (debounced, switches), hits grouped per session with marked snippets, ignored
 * `superseded`, a failed computer as an alert, keyboard choice → the session and `revealItem`.
 */

vi.setConfig({ testTimeout: 30_000 });

const LOGIN = sampleId('en', 1);
const DOCS = sampleId('en', 2);
const LOGIN_KEY = makeSessionKey(LOCAL_HOST_ID, LOGIN);
const DOCS_KEY = makeSessionKey(LOCAL_HOST_ID, DOCS);

let host: FakeHost | null = null;
const cleanups: (() => void)[] = [];
const queries: CommandOf<'search.query'>[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  cancelPendingReveal();
  unregisterConnection();
  host?.dispose();
  host = null;
  queries.length = 0;
  act(() => {
    resetSidebarView();
    setLanguage('en');
  });
  resetSearchMemory();
  resetClientStore();
});

function isQuery(cmd: Command): cmd is CommandOf<'search.query'> {
  return cmd.name === 'search.query';
}

function hits(): FakeAck {
  return {
    ok: true,
    result: {
      hits: [
        sampleSearchHit({ entryId: LOGIN, at: sampleTime(30), kind: 'prompt' }),
        sampleSearchHit({
          entryId: DOCS,
          at: sampleTime(20),
          kind: 'answer',
          itemId: 'msg-docs:0',
          snippet: 'The login docs are in the guide.',
          ranges: [[4, 9]],
        }),
        sampleSearchHit({
          entryId: LOGIN,
          at: sampleTime(10),
          kind: 'title',
          itemId: null,
          conversationId: null,
          snippet: 'Login work',
          ranges: [[0, 5]],
        }),
      ],
      truncated: false,
    },
  };
}

async function connect(
  options: { search?: boolean; answer?: (cmd: CommandOf<'search.query'>) => FakeAck } = {},
): Promise<FakeHost> {
  const transport = createMemoryTransport();
  const hostState: HostState = sampleHostState({
    features: { git: false, search: options.search ?? true, overview: false },
  });
  host = new FakeHost({
    transport,
    hostState,
    summaries: [
      sampleSummary({
        entryId: LOGIN,
        title: 'Login work',
        cwd: 'D:\\work\\sample',
        lastActivityAt: sampleTime(30),
      }),
      sampleSummary({
        entryId: DOCS,
        title: 'Docs',
        cwd: sampleWorktreeRef().path,
        worktree: sampleWorktreeRef(),
        archived: true,
        lastActivityAt: sampleTime(20),
      }),
    ],
    onCommand: (cmd) => {
      if (!isQuery(cmd)) return undefined;
      queries.push(cmd);
      return (options.answer ?? hits)(cmd);
    },
  });
  const connection = createHostConnection({ hostId: LOCAL_HOST_ID, createTransport: () => transport });
  registerConnection(connection);
  connection.start();
  await expect.poll(() => clientStore.getState().hosts.local?.hostState ?? null).not.toBeNull();
  await expect.poll(() => selectSummaryEntries(clientStore.getState()).length).toBe(2);
  return host;
}

function renderSlot(): void {
  cleanups.push(installShortcutListener());
  const Slot = SEARCH_SLOTS.SearchDialog;
  render(
    <TooltipProvider>
      <Slot />
    </TooltipProvider>,
  );
}

function open(text?: string): boolean {
  let taken = false;
  act(() => {
    taken = requestShell(text === undefined ? { kind: 'search.open' } : { kind: 'search.open', text });
  });
  return taken;
}

function input(): HTMLInputElement {
  return within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('combobox');
}

describe('search dialog (WP-115)', () => {
  it('without a computer that searches contents the request and the shortcut stay free', async () => {
    await connect({ search: false });
    renderSlot();
    expect(open('login')).toBe(false);
    const user = userEvent.setup();
    await user.keyboard('{Control>}{Shift>}f{/Shift}{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it('search.open with a text asks at once; hits grouped per session with title, kind and marks', async () => {
    await connect();
    renderSlot();
    expect(open('login')).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: 'Search in contents' });
    expect(input().value).toBe('login');
    await waitFor(() => {
      expect(queries).toHaveLength(1);
    });
    expect(queries[0]).toMatchObject({ text: 'login', includeArchived: true, includeToolOutput: false });

    const list = await within(dialog).findByRole('listbox', { name: 'Hits' });
    await waitFor(() => {
      expect(within(list).getAllByRole('option')).toHaveLength(3);
    });
    const groups = within(list).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('data-session'))).toEqual([LOGIN_KEY, DOCS_KEY]);
    const header = (group: HTMLElement | undefined) =>
      group?.querySelector('[data-slot="search-group-header"]')?.textContent ?? '';
    expect(header(groups[0])).toContain('Login work');
    expect(header(groups[0])).toContain('2 hits');
    // The worktree session names its repository and is archived.
    expect(header(groups[1])).toContain('Docs');
    expect(header(groups[1])).toContain('sample');
    expect(header(groups[1])).toContain('Archived');
    const options = within(list).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('data-kind'))).toEqual(['prompt', 'title', 'answer']);
    expect(options[0]?.querySelector('mark')?.textContent).toBe('login form');
    expect(within(dialog).getByText('3 hits')).toBeTruthy();
  });

  it('typing waits for 2 characters and a pause; the switches ask again at once', async () => {
    await connect();
    renderSlot();
    open();
    await screen.findByRole('dialog');
    const user = userEvent.setup();
    await user.type(input(), 'l');
    expect(screen.getByText('Type at least 2 characters.')).toBeTruthy();
    await user.type(input(), 'og');
    await waitFor(() => {
      expect(queries.map((query) => query.text)).toEqual(['log']);
    });
    await user.click(screen.getByRole('switch', { name: 'Tool output' }));
    await waitFor(() => {
      expect(queries).toHaveLength(2);
    });
    expect(queries[1]).toMatchObject({ text: 'log', includeToolOutput: true, includeArchived: true });
    await user.click(screen.getByRole('switch', { name: 'Include archived' }));
    await waitFor(() => {
      expect(queries[2]).toMatchObject({ includeArchived: false });
    });
  });

  it('ignores superseded answers silently; a failed computer shows an alert inside the dialog', async () => {
    let fail: 'superseded' | 'timeout' = 'superseded';
    await connect({ answer: () => ({ ok: false, error: makeError('SEARCH_FAILED', { reason: fail }) }) });
    renderSlot();
    open('login');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(queries).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fail = 'timeout';
    const user = userEvent.setup();
    await user.click(screen.getByRole('switch', { name: 'Tool output' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('this computer');
  });

  it('arrows move, Enter opens the session at the hit (revealItem) and closes; text and switches stay', async () => {
    await connect();
    renderSlot();
    const reveals: ShellRequestOf<'revealItem'>[] = [];
    cleanups.push(
      registerShellRequestHandler('revealItem', (request) => {
        reveals.push(request);
        return true;
      }),
    );
    open('login');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(3);
    });
    const user = userEvent.setup();
    const options = within(dialog).getAllByRole('option');
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input().getAttribute('aria-activedescendant')).toBe(options[2]?.id);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(clientStore.getState().selectedSession).toBe(DOCS_KEY);
    expect(reveals).toEqual([
      {
        kind: 'revealItem',
        sessionKey: DOCS_KEY,
        conversationId: SAMPLE_IDS.conversation,
        itemId: 'msg-docs:0',
      },
    ]);

    // Ctrl+Shift+F continues with the last text.
    await user.keyboard('{Control>}{Shift>}f{/Shift}{/Control}');
    await screen.findByRole('dialog');
    expect(input().value).toBe('login');
  });

  it('a click opens the hit; the jump waits until a transcript takes it', async () => {
    await connect();
    renderSlot();
    open('login');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getAllByRole('option')).toHaveLength(3);
    });
    const user = userEvent.setup();
    await user.click(within(dialog).getAllByRole('option')[0] ?? dialog);
    expect(clientStore.getState().selectedSession).toBe(LOGIN_KEY);
    // Nobody takes it yet (the transcript mounts later) – it is asked again.
    const reveals: ShellRequestOf<'revealItem'>[] = [];
    cleanups.push(
      registerShellRequestHandler('revealItem', (request) => {
        reveals.push(request);
        return true;
      }),
    );
    await waitFor(() => {
      expect(reveals).toHaveLength(1);
    });
    expect(reveals[0]).toMatchObject({ sessionKey: LOGIN_KEY, itemId: SAMPLE_IDS.messageUuid });
  });
});
