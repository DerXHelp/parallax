import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import type { Command, CommandOf } from '@shared/protocol';
import {
  SAMPLE_IDS,
  sampleDetail,
  sampleId,
  sampleItems,
  sampleSessionSnapshot,
  sampleTime,
} from '@shared/samples';
import { requestShell } from '@web/shell/requests';
import { createHostConnection, registerConnection, unregisterConnection } from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { clientStore, resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { resetExpansion } from './state/expansion';
import { REVEAL_MARK_MS } from './state/reveal';
import { installResizeObserver, installScrollEvents } from './testing';
import { TranscriptView } from './TranscriptView';

/**
 * WP-115 – the jump to a search hit (request `revealItem`): a loaded item is scrolled to and marked
 * briefly, one further back is loaded with `loadEarlier` first, one of another conversation comes as
 * an excerpt (`transcript.loadAround`); requests of other sessions are passed on.
 */

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await import('./markdown/MarkdownRenderer');
}, 180_000);

const ENTRY = sampleId('en', 115);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
const OTHER_CONVERSATION = sampleId('cv', 9);

let host: FakeHost | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreScrollEvents: (() => void) | null = null;
const around: CommandOf<'transcript.loadAround'>[] = [];

beforeEach(() => {
  restoreResizeObserver = installResizeObserver({ viewport: 2000, item: 40 });
  restoreScrollEvents = installScrollEvents();
});

afterEach(() => {
  unregisterConnection();
  host?.dispose();
  host = null;
  around.length = 0;
  resetClientStore();
  resetExpansion();
  restoreResizeObserver?.();
  restoreScrollEvents?.();
});

function prompt(n: number, text = `prompt ${String(n)}`, id = `p${String(n)}`): TranscriptItem {
  return sampleItems.userMessage({ id, order: n, at: sampleTime(n), text: { text, truncated: null } });
}

function prompts(count: number): TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => prompt(index + 1));
}

function isAround(cmd: Command): cmd is CommandOf<'transcript.loadAround'> {
  return cmd.name === 'transcript.loadAround';
}

async function show(items: TranscriptItem[]): Promise<FakeHost> {
  const transport = createMemoryTransport();
  host = new FakeHost({
    transport,
    onCommand: (cmd): FakeAck | undefined => {
      if (!isAround(cmd)) return undefined;
      around.push(cmd);
      return {
        ok: true,
        result: {
          items: [prompt(900, 'earlier 0'), prompt(901, 'earlier 1', cmd.itemId), prompt(902, 'earlier 2')],
          hasEarlier: true,
          hasLater: false,
        },
      };
    },
  });
  host.addSession(
    sampleSessionSnapshot({ entryId: ENTRY, seq: 0, items, detail: sampleDetail({ entryId: ENTRY }) }),
  );
  const connection = createHostConnection({ hostId: LOCAL_HOST_ID, createTransport: () => transport });
  registerConnection(connection);
  connection.start();
  await expect.poll(() => clientStore.getState().hosts.local?.hostState ?? null).not.toBeNull();
  render(<TranscriptView sessionKey={KEY} />);
  return host;
}

function reveal(
  itemId: string | null,
  conversationId: string | null = SAMPLE_IDS.conversation,
  sessionKey = KEY,
) {
  let taken = false;
  act(() => {
    taken = requestShell({ kind: 'revealItem', sessionKey, conversationId, itemId });
  });
  return taken;
}

function marked(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="transcript"] [data-row][data-revealed]');
}

describe('jump to a search hit (WP-115)', () => {
  it('a loaded item: its row is marked, the mark goes after a moment', async () => {
    await show(prompts(20));
    expect(await screen.findByText('prompt 20')).toBeTruthy();
    expect(reveal('p5')).toBe(true);
    await waitFor(() => {
      expect(marked()?.textContent).toContain('prompt 5');
    });
    await waitFor(
      () => {
        expect(marked()).toBeNull();
      },
      { timeout: REVEAL_MARK_MS + 2000 },
    );
  });

  it('an item further back: earlier items are loaded until it is there', async () => {
    const server = await show(prompts(300));
    expect(await screen.findByText('prompt 300')).toBeTruthy();
    expect(clientStore.getState().sessions[KEY]?.view?.hasEarlier).toBe(true);
    reveal('p10');
    await waitFor(() => {
      expect(marked()?.textContent).toContain('prompt 10');
    });
    expect(server.commands.filter((cmd) => cmd.name === 'transcript.loadEarlier').length).toBeGreaterThan(0);
    expect(around).toHaveLength(0);
  });

  it('another conversation: an excerpt with the hit marked, closable', async () => {
    await show(prompts(5));
    expect(await screen.findByText('prompt 5')).toBeTruthy();
    reveal('old-item', OTHER_CONVERSATION);
    const excerpt = await screen.findByRole('region', { name: 'Search hit' });
    expect(around).toEqual([
      {
        name: 'transcript.loadAround',
        entryId: ENTRY,
        conversationId: OTHER_CONVERSATION,
        itemId: 'old-item',
        around: 3,
      },
    ]);
    expect(within(excerpt).getByText('Search hit from an earlier conversation')).toBeTruthy();
    expect(excerpt.querySelector('[data-revealed]')?.textContent).toContain('earlier 1');
    expect(marked()).toBeNull();
    await userEvent.setup().click(within(excerpt).getByRole('button', { name: 'Close the search hit' }));
    expect(screen.queryByRole('region', { name: 'Search hit' })).toBeNull();
  });

  it('only its own session; a hit without an item only opens the session', async () => {
    await show(prompts(5));
    expect(await screen.findByText('prompt 5')).toBeTruthy();
    expect(reveal('p2', SAMPLE_IDS.conversation, makeSessionKey(LOCAL_HOST_ID, sampleId('en', 7)))).toBe(
      false,
    );
    expect(reveal(null, null)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(marked()).toBeNull();
    expect(around).toHaveLength(0);
  });
});
