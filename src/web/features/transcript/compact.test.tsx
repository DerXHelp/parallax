import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { ToolResult, TranscriptItem } from '@shared/model';
import {
  sampleBlobId,
  sampleBlobRef,
  sampleDetail,
  sampleId,
  sampleItems,
  sampleSessionSnapshot,
  sampleSummary,
  sampleSystemItems,
  sampleRateLimitInfo,
  sampleTime,
} from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { setTranscriptView } from '@web/state/transcript-view';
import { resetExpansion } from './state/expansion';
import { resetGroups } from './state/groups';
import { installResizeObserver, installScrollEvents, startTranscriptScenario } from './testing';
import { TranscriptView } from './TranscriptView';

/**
 * WP-63 §1.5 – the compact transcript in the list: a run of work steps is one group line with a
 * gallery of its pictures (also while closed), a click opens the steps; the view "all steps" shows
 * every item and one gallery for adjacent pictures; the lightbox steps through a gallery.
 */

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await import('./markdown/MarkdownRenderer');
}, 180_000);

let running: RunningScenario | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreScrollEvents: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserver({ viewport: 2000, item: 40 });
  restoreScrollEvents = installScrollEvents();
});

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  resetExpansion();
  act(() => {
    resetGroups();
  });
  restoreResizeObserver?.();
  restoreScrollEvents?.();
});

const ENTRY = sampleId('en', 63);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);

function imageResult(n: number): ToolResult {
  return {
    isError: false,
    content: [
      { type: 'image', image: sampleBlobRef({ blobId: sampleBlobId(n), name: `shot-${String(n)}.png` }) },
    ],
    structured: null,
    structuredTruncated: null,
    at: sampleTime(10 + n),
  };
}

function bash(id: string, order: number, command: string, failed = false): TranscriptItem {
  return sampleItems.toolCall({
    id,
    order,
    toolUseId: `toolu_${id}`,
    input: { command, description: command },
    at: sampleTime(order),
    result: {
      isError: failed,
      content: [{ type: 'text', text: { text: failed ? 'exit 1' : 'ok', truncated: null } }],
      structured: null,
      structuredTruncated: null,
      at: sampleTime(order + 1),
    },
  });
}

function read(id: string, order: number, n: number): TranscriptItem {
  return sampleItems.toolCall({
    id,
    order,
    toolUseId: `toolu_${id}`,
    toolName: 'Read',
    input: { file_path: `D:\\work\\shots\\shot-${String(n)}.png` },
    at: sampleTime(order),
    result: imageResult(n),
  });
}

/** User message, a run of 5 steps (thinking, 2× Bash with one failure, 2× Read with a picture), the answer. */
function items(): TranscriptItem[] {
  return [
    sampleItems.userMessage({ id: 'u1', order: 1, text: { text: 'Fix the build.', truncated: null } }),
    sampleItems.thinking({ id: 't1', order: 2, text: { text: 'Let me look.', truncated: null } }),
    bash('b1', 3, 'pnpm build'),
    sampleSystemItems.rate_limit({
      id: 'rl',
      order: 4,
      info: sampleRateLimitInfo({ status: 'allowed_warning', rateLimitType: 'seven_day_opus' }),
    }),
    bash('b2', 5, 'pnpm test', true),
    read('r1', 6, 21),
    read('r2', 7, 22),
    sampleItems.assistantText({ id: 'a1', order: 8, text: 'The build works again.' }),
  ];
}

function start(): void {
  running = startTranscriptScenario([
    {
      snapshot: sampleSessionSnapshot({
        entryId: ENTRY,
        seq: 0,
        items: items(),
        detail: sampleDetail({ entryId: ENTRY }),
      }),
      summary: sampleSummary({ entryId: ENTRY }),
    },
  ]);
}

function rowKinds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[data-row]')].map(
    (row) => `${row.dataset.row ?? ''}${row.dataset.nested === 'true' ? ':nested' : ''}`,
  );
}

describe('compact transcript (WP-63 §1.5)', () => {
  it('one group line per run of steps; the gallery shows while closed; a click opens the steps', async () => {
    start();
    render(<TranscriptView sessionKey={KEY} />);
    expect(await screen.findByText('Fix the build.')).toBeTruthy();
    const group = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="step-group"]');
      if (element === null) throw new Error('no group');
      return element;
    });
    // The hidden limit warning neither shows nor splits the run.
    expect(rowKinds()).toEqual(['item', 'group', 'item']);
    expect(group.dataset.state).toBe('closed');
    const toggle = within(group).getByRole('button', { name: /4 steps/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('2× Bash');
    expect(within(group).getByText('1 error')).toBeTruthy();
    const gallery = within(group).getByRole('list', { name: '2 images' });
    expect(
      within(gallery)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Enlarge image shot-21.png', 'Enlarge image shot-22.png']);
    expect(screen.queryByText('Let me look.')).toBeNull();

    const user = userEvent.setup();
    await user.click(toggle);
    await waitFor(() => {
      expect(rowKinds()).toEqual([
        'item',
        'group',
        'item:nested',
        'item:nested',
        'item:nested',
        'item:nested',
        'item:nested',
        'item',
      ]);
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // The pictures stay in the gallery only (no second thumbnail in the opened Read rows).
    expect(screen.getAllByRole('button', { name: 'Enlarge image shot-21.png' })).toHaveLength(1);

    await user.click(toggle);
    await waitFor(() => {
      expect(rowKinds()).toEqual(['item', 'group', 'item']);
    });
  });

  it('the error counter opens the group', async () => {
    start();
    render(<TranscriptView sessionKey={KEY} />);
    const errors = await screen.findByRole('button', { name: '1 error' });
    expect(errors.getAttribute('title')).toBe('Show the steps with errors');
    await userEvent.setup().click(errors);
    await waitFor(() => {
      expect(rowKinds().filter((kind) => kind === 'item:nested')).toHaveLength(5);
    });
  });

  it('opening a group keeps its line in place instead of following the end', async () => {
    // 3 rows of 40 px fit into 200 px (the list sticks to the end); opened, 8 rows do not.
    restoreResizeObserver?.();
    restoreResizeObserver = installResizeObserver({ viewport: 200, item: 40 });
    start();
    render(<TranscriptView sessionKey={KEY} />);
    const region = await screen.findByRole('region', { name: 'Transcript' });
    const toggle = await screen.findByRole('button', { name: /4 steps/ });
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    await userEvent.setup().click(toggle);
    await waitFor(() => {
      expect(rowKinds()).toContain('item:nested');
    });
    // Following the end would have scrolled the group line away (scrollTop 120).
    expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeTruthy();
    expect(region.scrollTop).toBe(0);
    expect(toggle.isConnected).toBe(true);
  });

  it('view "all steps": every item a row, adjacent pictures in one gallery row', async () => {
    start();
    render(<TranscriptView sessionKey={KEY} />);
    expect(await screen.findByText('Fix the build.')).toBeTruthy();
    // WP-65 §1.6: a server setting – switched once the host state is there.
    await act(async () => {
      await setTranscriptView('all');
    });
    await waitFor(() => {
      expect(rowKinds()).toEqual(['item', 'item', 'item', 'item', 'item', 'item', 'gallery', 'item']);
    });
    expect(document.querySelector('[data-slot="step-group"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Enlarge image shot-2[12]\.png$/ })).toHaveLength(2);
    // Switching back regroups at once.
    await act(async () => {
      await setTranscriptView('compact');
    });
    await waitFor(() => {
      expect(rowKinds()).toEqual(['item', 'group', 'item']);
    });
  });

  it('the lightbox steps through the gallery: buttons, position, arrow keys', async () => {
    start();
    render(<TranscriptView sessionKey={KEY} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Enlarge image shot-21.png' }));
    const dialog = await screen.findByRole('dialog', { name: 'Image: shot-21.png' });
    expect(within(dialog).getByText('Image 1 of 2')).toBeTruthy();
    const previous = within(dialog).getByRole('button', { name: 'Previous image (←)' });
    expect(previous.hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Next image (→)' }));
    expect(await screen.findByRole('dialog', { name: 'Image: shot-22.png' })).toBeTruthy();
    expect(screen.getByText('Image 2 of 2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next image (→)' }).hasAttribute('disabled')).toBe(true);
    await user.keyboard('{ArrowLeft}');
    expect(await screen.findByRole('dialog', { name: 'Image: shot-21.png' })).toBeTruthy();
  });
});
