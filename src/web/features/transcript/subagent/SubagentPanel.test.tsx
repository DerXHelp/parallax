import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { TranscriptItem } from '@shared/model';
import type { Command, CommandOf } from '@shared/protocol';
import { sampleId, sampleItems, sampleSessionSnapshot, sampleSystemItems, sampleTime } from '@shared/samples';
import { createHostConnection, registerConnection, unregisterConnection } from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { setHookDisplay } from '@web/state/hook-display';
import { clientStore, resetClientStore } from '@web/state/store';
import { setTranscriptView } from '@web/state/transcript-view';
import { createMemoryTransport } from '@web/state/transport';
import { TooltipProvider } from '@web/ui/tooltip';
import { resetExpansion } from '../state/expansion';
import { resetGroups } from '../state/groups';
import { useSubagentTranscript } from '../state/subagent-transcript';
import { installResizeObserver, installScrollEvents } from '../testing';
import { SubagentPanel } from './SubagentPanel';

/**
 * WP-69 – the side panel tab "Agent": the polling hook (grows while the agent runs, stops at its
 * end, on unmount, while the window is hidden and after an error) and the panel (header, compact
 * groups per `transcriptView`, hook runs per `hookDisplay`, read-only rows). The FakeHost answers
 * `session.subagentTranscript` from a list the test grows.
 */

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  await import('../markdown/MarkdownRenderer');
}, 180_000);

const ENTRY = sampleId('en', 69);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
const AGENT = 'a655391549dc96788';

let host: FakeHost | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreScrollEvents: (() => void) | null = null;
const reads: CommandOf<'session.subagentTranscript'>[] = [];

/** The agent's list on the "server" and its state. */
const agent = { items: [] as TranscriptItem[], running: true, fail: false };

function answer(cmd: CommandOf<'session.subagentTranscript'>): FakeAck {
  reads.push(cmd);
  if (agent.fail) return { ok: false, error: makeError('FILE_NOT_READABLE', { agentId: cmd.agentId }) };
  const total = agent.items.length;
  const offset = cmd.offset === null ? Math.max(0, total - cmd.limit) : Math.min(cmd.offset, total);
  return {
    ok: true,
    result: { items: agent.items.slice(offset, offset + cmd.limit), offset, total, running: agent.running },
  };
}

function isSubagentCommand(cmd: Command): cmd is CommandOf<'session.subagentTranscript'> {
  return cmd.name === 'session.subagentTranscript';
}

async function connect(): Promise<FakeHost> {
  const transport = createMemoryTransport();
  host = new FakeHost({
    transport,
    onCommand: (cmd) => (isSubagentCommand(cmd) ? answer(cmd) : undefined),
  });
  host.addSession(sampleSessionSnapshot({ entryId: ENTRY, seq: 0, items: [] }));
  const connection = createHostConnection({ hostId: LOCAL_HOST_ID, createTransport: () => transport });
  registerConnection(connection);
  connection.start();
  await expect.poll(() => clientStore.getState().hosts.local?.hostState ?? null).not.toBeNull();
  return host;
}

function text(n: number, value = `answer ${String(n)}`): TranscriptItem {
  return sampleItems.assistantText({ id: `m${String(n)}:0`, messageId: `m${String(n)}`, order: n, text: value });
}
function bash(n: number, status: 'running' | 'done' = 'done'): TranscriptItem {
  return sampleItems.toolCall({
    id: `m${String(n)}:1`,
    messageId: `m${String(n)}`,
    order: n,
    toolUseId: `toolu_${String(n)}`,
    input: { command: `step ${String(n)}`, description: `step ${String(n)}` },
    status,
    at: sampleTime(n),
    result:
      status === 'running'
        ? null
        : {
            isError: false,
            content: [{ type: 'text', text: { text: 'ok', truncated: null } }],
            structured: null,
            structuredTruncated: null,
            at: sampleTime(n + 1),
          },
  });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  agent.items = [];
  agent.running = true;
  agent.fail = false;
  reads.length = 0;
  restoreResizeObserver = installResizeObserver({ viewport: 2000, item: 40 });
  restoreScrollEvents = installScrollEvents();
});

afterEach(() => {
  unregisterConnection();
  host?.dispose();
  host = null;
  resetClientStore();
  resetExpansion();
  act(() => {
    resetGroups();
  });
  Reflect.deleteProperty(document, 'visibilityState');
  restoreResizeObserver?.();
  restoreScrollEvents?.();
});

describe('useSubagentTranscript (WP-69)', () => {
  it('grows while the agent runs – each poll only from the first open item – and stops at its end', async () => {
    await connect();
    agent.items = [text(1), bash(2, 'running')];
    const { result } = renderHook(() => useSubagentTranscript(KEY, AGENT, 10));
    await waitFor(() => {
      expect(result.current.pages?.items).toHaveLength(2);
    });
    expect(reads[0]).toMatchObject({ entryId: ENTRY, agentId: AGENT, offset: null, conversationId: null });
    // The open Bash call is where the next poll starts.
    await waitFor(() => {
      expect(reads.length).toBeGreaterThan(1);
    });
    expect(reads[1]?.offset).toBe(1);
    agent.items = [text(1), bash(2), text(3)];
    await waitFor(() => {
      expect(result.current.pages?.items.map((item) => item.id)).toEqual(['m1:0', 'm2:1', 'm3:0']);
    });
    expect(result.current.pages?.items[1]).toMatchObject({ status: 'done' });
    agent.running = false;
    await waitFor(() => {
      expect(result.current.pages?.running).toBe(false);
    });
    const count = reads.length;
    await wait(60);
    expect(reads.length).toBe(count);
  });

  it('polling stops on unmount and while the window is hidden (one read when visible again)', async () => {
    await connect();
    agent.items = [text(1)];
    const { result, unmount } = renderHook(() => useSubagentTranscript(KEY, AGENT, 10));
    await waitFor(() => {
      expect(result.current.pages?.items).toHaveLength(1);
    });
    act(() => {
      setVisibility('hidden');
    });
    await wait(30);
    const hidden = reads.length;
    await wait(60);
    expect(reads.length).toBe(hidden);
    agent.items = [text(1), text(2)];
    act(() => {
      setVisibility('visible');
    });
    await waitFor(() => {
      expect(result.current.pages?.items).toHaveLength(2);
    });
    unmount();
    await wait(30);
    const gone = reads.length;
    await wait(60);
    expect(reads.length).toBe(gone);
  });

  it('an error stops polling and shows; refresh reads again', async () => {
    await connect();
    agent.fail = true;
    const { result } = renderHook(() => useSubagentTranscript(KEY, AGENT, 10));
    await waitFor(() => {
      expect(result.current.error).toEqual({ code: 'FILE_NOT_READABLE', params: { agentId: AGENT } });
    });
    await wait(60);
    expect(reads).toHaveLength(1);
    agent.fail = false;
    agent.items = [text(1)];
    agent.running = false;
    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.pages?.items).toHaveLength(1);
    });
    expect(result.current.error).toBeNull();
  });

  it('"earlier entries" prepends the page before the window', async () => {
    await connect();
    agent.running = false;
    agent.items = Array.from({ length: 250 }, (_, index) => text(index + 1));
    const { result } = renderHook(() => useSubagentTranscript(KEY, AGENT, 10));
    await waitFor(() => {
      expect(result.current.pages).toMatchObject({ offset: 50, total: 250 });
    });
    act(() => {
      result.current.loadEarlier();
    });
    await waitFor(() => {
      expect(result.current.pages?.offset).toBe(0);
    });
    expect(result.current.pages?.items).toHaveLength(250);
    expect(reads.at(-1)).toMatchObject({ offset: 0, limit: 50 });
  });
});

describe('SubagentPanel (WP-69)', () => {
  /** The agent's prompt, a run of three steps (a successful hook among them), a blocked hook, the answer. */
  function transcript(): TranscriptItem[] {
    return [
      sampleItems.userMessage({ id: 'p', order: 1, text: { text: 'Look around.', truncated: null } }),
      bash(2),
      sampleSystemItems.hook({ id: 'h-ok', order: 3, hookName: 'PostToolUse:Bash', outcome: 'success', exitCode: 0 }),
      bash(4),
      sampleSystemItems.hook({
        id: 'h-block',
        order: 5,
        hookName: 'PreToolUse:Write',
        hookEvent: 'PreToolUse',
        outcome: 'error',
        exitCode: 2,
        output: { text: 'Writing is blocked\n', truncated: null },
      }),
      bash(6, 'running'),
      text(7, 'Done looking.'),
    ];
  }

  function renderPanel() {
    return render(
      <TooltipProvider>
        <SubagentPanel sessionKey={KEY} agentId={AGENT} title="Explore the project" subagentType="Explore" />
      </TooltipProvider>,
    );
  }

  it('header, compact groups, the blocked hook as an error, read-only rows (no "Background")', async () => {
    await connect();
    agent.items = transcript();
    agent.running = false;
    renderPanel();
    expect(await screen.findByText('Done looking.')).toBeTruthy();
    const panel = document.querySelector<HTMLElement>('[data-slot="subagent-panel"]');
    expect(panel?.dataset.agentId).toBe(AGENT);
    expect(panel?.dataset.running).toBe('false');
    expect(screen.getByText('Explore the project')).toBeTruthy();
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.getByText('7 entries')).toBeTruthy();
    // Default "failed": the successful hook is gone, the steps around it form one group; the
    // blocking hook is an error notice that ends the group.
    const group = document.querySelector<HTMLElement>('[data-slot="step-group"]');
    expect(group).not.toBeNull();
    expect(within(group ?? document.body).getByRole('button', { name: /2 steps/ })).toBeTruthy();
    const blocked = document.querySelector<HTMLElement>('[data-slot="hook-failed"]');
    expect(blocked?.textContent).toContain('Hook PreToolUse blocked Write');
    expect(document.querySelector('[data-slot="hook"]')).toBeNull();
    // The running Bash of the agent: no "Background" (read-only).
    expect(screen.queryByRole('button', { name: /background/i })).toBeNull();
    // A finished agent is read once.
    await wait(60);
    expect(reads).toHaveLength(1);
  });

  it('"all" hooks: the successful run joins the group as "1× Hook"; view "all steps": one row per item', async () => {
    await connect();
    agent.items = transcript();
    agent.running = false;
    await act(async () => {
      await setHookDisplay('all');
    });
    renderPanel();
    const toggle = await screen.findByRole('button', { name: /3 steps/ });
    expect(toggle.textContent).toContain('1× Hook');
    await act(async () => {
      await setTranscriptView('all');
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="step-group"]')).toBeNull();
    });
    expect(document.querySelector('[data-slot="hook"]')?.getAttribute('data-hook')).toBe('PostToolUse:Bash');
  });

  it('a running agent shows it and polls; a failed read shows the error with "Try again"', async () => {
    await connect();
    agent.items = [text(1)];
    agent.fail = true;
    renderPanel();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The transcript could not be loaded.');
    agent.fail = false;
    act(() => {
      within(alert).getByRole('button', { name: 'Try again' }).click();
    });
    expect(await screen.findByText('answer 1')).toBeTruthy();
    expect(document.querySelector<HTMLElement>('[data-slot="subagent-panel"]')?.dataset.running).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
