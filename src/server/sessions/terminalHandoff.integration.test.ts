/**
 * 102e – "Continue in terminal" (`session.openInTerminal`) through the real manager with the
 * FakeBackend, memory stores, a virtual clock and a test double of the terminal service: the query is
 * closed before claude starts in the terminal, the handoff record names the terminal, the watch asks
 * the terminal service (ended → the return imports the turns), `session.reclaim` while it runs, errors
 * of the terminal pass through, and a restart (the terminals end with the server) brings it back.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId, TerminalId } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import { currentConversation } from '@shared/model';
import { SAMPLE_TIME, sampleId } from '@shared/samples';
import type {
  TerminalClaudeLaunch,
  TerminalClaudeOpenResult,
  TerminalClaudeState,
  TerminalOrigin,
} from '../terminal/ports';
import type { EngineTerminal } from './entryState';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const POLL_MS = 5_000;
const TERMINAL_PID = 61_000;
const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

interface OpenCall {
  entryId: EntryId;
  launch: TerminalClaudeLaunch;
  origin: TerminalOrigin;
  since: number | undefined;
}

interface TestTerminal extends EngineTerminal {
  readonly opened: OpenCall[];
  /** The `remoteEpoch()` value the next calls read. */
  epoch: number;
  setState(terminalId: TerminalId, state: TerminalClaudeState): void;
  failNext(error: ErrorPayload): void;
}

function terminalIdOf(n: number): TerminalId {
  return `tm_${n.toString(16).padStart(32, '0')}`;
}

/** Hands out `tm_…1`, `tm_…2` …; unknown ids are `ended` (like the service after a restart). */
function createTestTerminal(onOpen: (launch: TerminalClaudeLaunch) => void): TestTerminal {
  const opened: OpenCall[] = [];
  const states = new Map<TerminalId, TerminalClaudeState>();
  let next = 1;
  let failure: ErrorPayload | null = null;
  return {
    opened,
    epoch: 0,
    remoteEpoch() {
      return this.epoch;
    },
    setState(terminalId, state) {
      states.set(terminalId, state);
    },
    failNext(error) {
      failure = error;
    },
    openClaude(entryId, launch, origin = 'local', since): Promise<TerminalClaudeOpenResult> {
      opened.push({ entryId, launch, origin, since });
      if (failure !== null) {
        const error = failure;
        failure = null;
        return Promise.resolve({ kind: 'failed', error });
      }
      const terminalId = terminalIdOf(next);
      next += 1;
      states.set(terminalId, 'running');
      onOpen(launch);
      return Promise.resolve({ kind: 'opened', terminalId, pid: TERMINAL_PID });
    },
    claudeState(terminalId) {
      return states.get(terminalId) ?? 'ended';
    },
  };
}

interface Setup {
  h: EngineHarness;
  terminal: TestTerminal;
}

/** Harness + test terminal; every claude started in a terminal makes one turn in the fake transcript. */
async function setup(options: EngineHarnessOptions = {}): Promise<Setup> {
  const ref: { h: EngineHarness | null } = { h: null };
  const terminal = createTestTerminal((launch) => {
    const sessionId = launch.args[launch.args.indexOf('--resume') + 1];
    if (ref.h !== null && sessionId !== undefined) ref.h.backend.simulateConsoleTurn(sessionId, ref.h.now());
  });
  const h = await createEngineHarness({ terminal, ...options });
  harnesses.push(h);
  ref.h = h;
  return { h, terminal };
}

async function idleEntry(h: EngineHarness): Promise<EntryId> {
  const entryId = await h.create('Reply with exactly: OK');
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function sessionIdOf(h: EngineHarness, entryId: EntryId): string {
  const sessionId = h.summary(entryId).sessionId;
  if (sessionId === null) throw new Error('no session id');
  return sessionId;
}

describe('session.openInTerminal (102e)', () => {
  it('closes the query, starts claude --resume in a terminal and records the terminal', async () => {
    const { h, terminal } = await setup();
    const entryId = await idleEntry(h);
    const sessionId = sessionIdOf(h, entryId);
    const result = await h.cmd({ name: 'session.openInTerminal', entryId });
    expect(result).toEqual({ terminalId: terminalIdOf(1) });
    // Never two writers: the SDK process had ended before claude started in the terminal.
    expect(h.session(entryId).state).toBe('exited');
    expect(terminal.opened).toHaveLength(1);
    expect(terminal.opened[0]?.entryId).toBe(entryId);
    expect(terminal.opened[0]?.origin).toBe('local');
    expect(terminal.opened[0]?.launch.args).toEqual(['--resume', sessionId]);
    const entry = h.stores.registry.get(entryId);
    expect(entry?.external).toEqual({
      pid: TERMINAL_PID,
      processStartedAt: null,
      since: SAMPLE_TIME,
      conversationId: entry === undefined ? null : currentConversation(entry).id,
      terminalId: terminalIdOf(1),
    });
    expect(h.status(entryId).kind).toBe('external');
    expect(h.summary(entryId).external).toEqual({
      since: SAMPLE_TIME,
      pid: TERMINAL_PID,
      running: true,
      terminalId: terminalIdOf(1),
    });
    expect(h.manager.inspect(entryId)).toMatchObject({ phase: 'dormant', externalWatched: true });
    // While handed off: only the console-safe commands; a second handoff is refused.
    expect((await h.cmdError({ name: 'session.openInTerminal', entryId })).code).toBe('SESSION_EXTERNAL');
    expect((await h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: 'x' } })).code).toBe(
      'SESSION_EXTERNAL',
    );
  });

  it('refuses reclaim while claude runs; ended → import of the turns and sleeping', async () => {
    const { h, terminal } = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.openInTerminal', entryId });
    expect(await h.cmdError({ name: 'session.reclaim', entryId })).toEqual(
      makeError('EXTERNAL_STILL_RUNNING', { pid: TERMINAL_PID }),
    );
    h.timers.advance(POLL_MS);
    await h.settle();
    expect(h.facts(entryId).runState).toBe('external');
    terminal.setState(terminalIdOf(1), 'ended');
    h.timers.advance(POLL_MS);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    await h.settle();
    expect(h.stores.registry.get(entryId)?.external).toBeNull();
    expect(h.summary(entryId).external).toBeNull();
    const returned = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'item.upsert' ? [op.item] : []))
      .filter((item) => item.kind === 'system' && item.event === 'handoff' && item.phase === 'returned');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ importedItems: expect.any(Number) as number });
    expect((returned[0] as { importedItems: number }).importedItems).toBeGreaterThan(0);
  });

  it('without a terminal service: TERMINAL_UNAVAILABLE before anything changed', async () => {
    const h = await createEngineHarness();
    harnesses.push(h);
    const entryId = await idleEntry(h);
    expect(await h.cmdError({ name: 'session.openInTerminal', entryId })).toEqual(
      makeError('TERMINAL_UNAVAILABLE', { reason: 'platform' }),
    );
    expect(h.stores.registry.get(entryId)?.external).toBeNull();
    expect(h.facts(entryId).runState).toBe('idle');
  });

  it('passes errors of the terminal through and stays here', async () => {
    const { h, terminal } = await setup();
    const entryId = await idleEntry(h);
    terminal.failNext(makeError('TERMINAL_LIMIT_REACHED', { scope: 'entry', max: 8 }));
    expect(await h.cmdError({ name: 'session.openInTerminal', entryId })).toEqual(
      makeError('TERMINAL_LIMIT_REACHED', { scope: 'entry', max: 8 }),
    );
    expect(h.stores.registry.get(entryId)?.external).toBeNull();
    expect(h.facts(entryId).runState).not.toBe('external');
    // The next try works.
    expect(await h.cmd({ name: 'session.openInTerminal', entryId })).toEqual({ terminalId: terminalIdOf(1) });
  });

  it('a restart returns a terminal handoff (the terminals ended with the server)', async () => {
    const s = await setup();
    const entryId = await idleEntry(s.h);
    await s.h.cmd({ name: 'session.openInTerminal', entryId });
    harnesses.splice(harnesses.indexOf(s.h), 1);
    expect(s.h.errors).toEqual([]);
    // A new terminal service knows no terminal of the earlier run.
    const fresh = createTestTerminal(() => undefined);
    const next = await s.h.restart({ terminal: fresh });
    harnesses.push(next);
    await next.manager.externalChecksDone();
    await next.waitFor(() => next.facts(entryId).runState === 'sleeping');
    await next.settle();
    expect(next.stores.registry.get(entryId)?.external).toBeNull();
  });

  it('a paired computer starts a remote terminal (WP-76 §B.13: unpairing ends it)', async () => {
    const { h, terminal } = await setup();
    const entryId = await idleEntry(h);
    const result = await h.manager.handleCommand(
      { name: 'session.openInTerminal', entryId },
      { clientId: sampleId('cl', 7), cmdId: randomUUID(), access: 'control' },
    );
    expect(result).toEqual({ terminalId: terminalIdOf(1) });
    expect(terminal.opened.map((o) => o.origin)).toEqual(['remote']);
    // Security review WP-109: the epoch read when the command arrived travels along (the terminal
    // service refuses the start once remote access was closed meanwhile); a local start has none.
    expect(terminal.opened[0]?.since).toBe(0);
  });
});
