/**
 * WP-34 – external console (ADR-104, WP-30 §4.12) through the real manager with the FakeBackend,
 * memory stores, a virtual clock and a test-double ConsoleLauncher: preconditions, the query is
 * closed before the console opens, open failures, the watch every `externalPollMs`, the automatic
 * return with the import of the console turns (time window, duplicate filter, read errors),
 * `session.reclaim`, server restart with a running/ended console, `session.consoleCommand` and
 * the secrets of the console env (never in a log, an op, an item or an error). Everything
 * published passes the hub-like validation of the memory publisher.
 */
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { currentConversation, type TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import { SAMPLE_TIME } from '@shared/samples';
import { FAKE_CONSOLE_PROMPT, fakeConsoleAnswer } from '../backend/fakeBackend';
import type { HistoryMessage } from '../backend/types';
import { consoleCommandText } from '../claude/consoleCommand';
import { REDACTED } from '../lib/logger';
import { CommandError } from '../sync/ports';
import { HANDOFF_IMPORT_SLACK_MS } from './external';
import {
  createTestConsoleLauncher,
  TEST_CONSOLE_FIRST_PID,
  type TestConsoleLauncher,
} from './testing/consoleLauncher';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const POLL_MS = 5_000;
const PID = TEST_CONSOLE_FIRST_PID;
const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

interface Setup {
  h: EngineHarness;
  launcher: TestConsoleLauncher;
  /** The harness clock the launcher uses (switched to the new harness after a restart). */
  clock: { now: () => Date };
}

/**
 * Harness + test console. `simulate` (default true): every opened console makes one turn in the
 * fake CLI transcript at the current time (like WP-40's fake console).
 */
async function setup(options: EngineHarnessOptions = {}, simulate = true): Promise<Setup> {
  const clock = { now: () => new Date(SAMPLE_TIME) };
  const ref: { h: EngineHarness | null } = { h: null };
  const launcher = createTestConsoleLauncher({
    now: () => clock.now(),
    onOpen: (spec) => {
      const sessionId = spec.args[spec.args.indexOf('--resume') + 1];
      if (simulate && ref.h !== null && sessionId !== undefined) {
        ref.h.backend.simulateConsoleTurn(sessionId, clock.now());
      }
    },
  });
  const h = await createEngineHarness({ consoleLauncher: launcher, ...options });
  harnesses.push(h);
  ref.h = h;
  clock.now = () => h.now();
  return { h, launcher, clock };
}

async function restart(s: Setup, options: Partial<EngineHarnessOptions> = {}): Promise<EngineHarness> {
  const index = harnesses.indexOf(s.h);
  if (index >= 0) harnesses.splice(index, 1);
  expect(s.h.errors).toEqual([]);
  const next = await s.h.restart(options);
  harnesses.push(next);
  s.clock.now = () => next.now();
  await next.manager.externalChecksDone();
  return next;
}

/** A running entry that finished its first turn (interactive scenario: idle). */
async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function sessionIdOf(h: EngineHarness, entryId: EntryId): string {
  const sessionId = h.summary(entryId).sessionId;
  if (sessionId === null) throw new Error('no session id');
  return sessionId;
}

function upserts(h: EngineHarness, entryId: EntryId): TranscriptItem[] {
  return h.publisher.opsOf(entryId).flatMap((op: SessionOp) => (op.op === 'item.upsert' ? [op.item] : []));
}

function handoffs(
  h: EngineHarness,
  entryId: EntryId,
): { phase: string; importedItems: number; order: number }[] {
  return upserts(h, entryId).flatMap((item) =>
    item.kind === 'system' && item.event === 'handoff'
      ? [{ phase: item.phase, importedItems: item.importedItems, order: item.order }]
      : [],
  );
}

function pendingMs(h: EngineHarness): number[] {
  return h.timers.pending().map((t) => t.ms);
}

/** Lets the console end and the next check bring the session back. */
async function consoleEnds(s: Setup, entryId: EntryId, pid: number | null = PID): Promise<void> {
  s.launcher.setState(pid, 'ended');
  s.h.timers.advance(POLL_MS);
  await s.h.waitFor(() => s.h.facts(entryId).runState === 'sleeping');
  await s.h.settle();
}

// =====================================================================================
// session.openExternal
// =====================================================================================

describe('session.openExternal (ADR-104)', () => {
  it('closes the query first, then opens claude --resume; external facts, entry, item and summary', async () => {
    const s = await setup();
    const { h, launcher } = s;
    const entryId = await idleEntry(h);
    const sessionId = sessionIdOf(h, entryId);
    const processStates: string[] = [];
    const hook = launcher.open.bind(launcher);
    launcher.open = (spec) => {
      processStates.push(h.session(entryId).state);
      return hook(spec);
    };
    await h.cmd({ name: 'session.setModel', entryId, model: 'opus' });
    await h.cmd({ name: 'session.setPermissionMode', entryId, mode: 'acceptEdits' });

    expect(await h.cmd({ name: 'session.openExternal', entryId })).toEqual({ pid: PID });
    // Never two writers: the SDK process had ended before the console opened.
    expect(processStates).toEqual(['exited']);
    expect(h.claude.consoleLaunches).toEqual([
      {
        profileId: 'standard',
        entryId,
        cwd: h.stores.registry.get(entryId)?.cwd,
        resumeSessionId: sessionId,
        model: 'opus',
        permissionMode: 'acceptEdits',
      },
    ]);
    expect(launcher.opened[0]?.args).toEqual(['--resume', sessionId]);
    const entry = h.stores.registry.get(entryId);
    expect(entry?.external).toEqual({
      pid: PID,
      processStartedAt: SAMPLE_TIME,
      since: SAMPLE_TIME,
      conversationId: entry === undefined ? null : currentConversation(entry).id,
    });
    expect(entry?.lastRunState).toBe('external');
    expect(h.status(entryId).kind).toBe('external');
    expect(h.summary(entryId).external).toEqual({ since: SAMPLE_TIME, pid: PID, running: true });
    expect(handoffs(h, entryId)).toEqual([
      { phase: 'external', importedItems: 0, order: expect.any(Number) as number },
    ]);
    // The item is in the log too; the watch timer is the only one (no sleep, no retry).
    const conversationId = entry === undefined ? '' : currentConversation(entry).id;
    expect(
      h.stores.transcripts
        .items(entryId, conversationId)
        .some((i) => i.kind === 'system' && i.event === 'handoff' && i.phase === 'external'),
    ).toBe(true);
    expect(pendingMs(h)).toEqual([POLL_MS]);
    expect(h.manager.inspect(entryId)).toMatchObject({ phase: 'dormant', externalWatched: true });
  });

  it('preconditions: no Claude session, busy, archived, no console launcher', async () => {
    const s = await setup();
    const { h, launcher } = s;
    const fresh = await h.create(null);
    expect(await h.cmdError({ name: 'session.openExternal', entryId: fresh })).toEqual({
      code: 'SESSION_NOT_STARTED',
      params: { entryId: fresh },
    });

    const busy = await h.create('fake:bash');
    await h.waitFor(() => h.facts(busy).decisions.permission === 1);
    await h.settle();
    expect(await h.cmdError({ name: 'session.openExternal', entryId: busy })).toEqual({
      code: 'SESSION_BUSY',
      params: { entryId: busy },
    });
    expect(h.session(busy).state).not.toBe('exited');

    const archived = await idleEntry(h);
    await h.cmd({ name: 'session.setArchived', entryId: archived, archived: true });
    expect((await h.cmdError({ name: 'session.openExternal', entryId: archived })).code).toBe(
      'SESSION_ARCHIVED',
    );
    expect(launcher.opened).toEqual([]);

    const none = await createEngineHarness();
    harnesses.push(none);
    const running = await idleEntry(none);
    expect(await none.cmdError({ name: 'session.openExternal', entryId: running })).toEqual({
      code: 'EXTERNAL_CONSOLE_FAILED',
      params: { reason: 'unavailable' },
    });
    // Nothing was closed.
    expect(none.session(running).state).not.toBe('exited');
    expect(none.facts(running).runState).toBe('idle');
  });

  it('an open failure → EXTERNAL_CONSOLE_FAILED {reason}; the entry stays dormant, nothing recorded', async () => {
    const { h, launcher } = await setup();
    const entryId = await idleEntry(h);
    launcher.failNext('exit 3: Start-Process is blocked');
    expect(await h.cmdError({ name: 'session.openExternal', entryId })).toEqual({
      code: 'EXTERNAL_CONSOLE_FAILED',
      params: { reason: 'exit 3: Start-Process is blocked' },
    });
    expect(h.facts(entryId).runState).toBe('sleeping');
    expect(h.stores.registry.get(entryId)?.external).toBeNull();
    expect(handoffs(h, entryId)).toEqual([]);
    expect(h.timers.pending()).toEqual([]);
    // A profile error passes through (and also leaves it dormant).
    h.claude.setLaunchError(makeError('CLAUDE_NOT_FOUND'));
    expect((await h.cmdError({ name: 'session.openExternal', entryId })).code).toBe('CLAUDE_NOT_FOUND');
    h.claude.setLaunchError(null);
    expect(h.facts(entryId).runState).toBe('sleeping');
    // The next prompt resumes it here.
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    expect(h.backend.starts).toHaveLength(2);
  });

  it('a console without PID/start time: pid null in the result, the entry and the summary', async () => {
    const { h, launcher } = await setup();
    const entryId = await idleEntry(h);
    launcher.unknownNext();
    expect(await h.cmd({ name: 'session.openExternal', entryId })).toEqual({ pid: null });
    expect(h.stores.registry.get(entryId)?.external).toMatchObject({ pid: null, processStartedAt: null });
    expect(h.summary(entryId).external).toMatchObject({ pid: null, running: true });
  });
});

// =====================================================================================
// Races with a slow console start (R4-01, R4-03)
// =====================================================================================

describe('commands and the shutdown while the console opens (R4-01, R4-03)', () => {
  it('R4-01: prompt, resume, second openExternal, archive and switch that waited for the lock → SESSION_EXTERNAL', async () => {
    const { h, launcher } = await setup();
    const entryId = await idleEntry(h);
    const starts = h.backend.starts.length;
    const conversationId = h.manager.inspect(entryId)?.conversationId ?? '';
    const hold = launcher.holdNext();
    const opening = h.cmd({ name: 'session.openExternal', entryId });
    await hold.reached;
    // Each passed the gate on arrival (the entry was not external yet) and waits for the lock.
    const waiting = [
      h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } }),
      h.cmdError({ name: 'session.resume', entryId }),
      h.cmdError({ name: 'session.openExternal', entryId }),
      h.cmdError({ name: 'session.setArchived', entryId, archived: true }),
      h.cmdError({ name: 'session.switchConversation', entryId, conversationId }),
    ];
    await h.settle();
    hold.release();
    expect(await opening).toEqual({ pid: PID });
    const errors = await Promise.all(waiting);
    expect(errors).toEqual(errors.map(() => ({ code: 'SESSION_EXTERNAL', params: { entryId } })));
    // Never two writers: one console, no new SDK process, the status stays external.
    expect(launcher.opened).toHaveLength(1);
    expect(h.backend.starts).toHaveLength(starts);
    expect(h.facts(entryId).runState).toBe('external');
    expect(h.summary(entryId)).toMatchObject({ archived: false, external: { pid: PID, running: true } });
    expect(h.manager.inspect(entryId)).toMatchObject({ phase: 'dormant', externalWatched: true });
  });

  it('R4-03: a shutdown while the console opens waits for it; the handoff survives the restart', async () => {
    const s = await setup();
    const entryId = await idleEntry(s.h);
    const hold = s.launcher.holdNext();
    const opening = s.h.cmd({ name: 'session.openExternal', entryId });
    await hold.reached;
    let stopped = false;
    const stopping = s.h.manager.shutdown().then(() => {
      stopped = true;
    });
    await s.h.settle();
    expect(stopped).toBe(false);
    hold.release();
    expect(await opening).toEqual({ pid: PID });
    await stopping;
    expect(s.h.stores.registry.get(entryId)?.external).toMatchObject({ pid: PID });
    const h = await restart(s);
    expect(h.facts(entryId).runState).toBe('external');
    expect(h.manager.inspect(entryId)?.externalWatched).toBe(true);
    expect(s.launcher.opened).toHaveLength(1);
  });

  it('R4-03: the wait is bounded (lifecycleShutdownWaitMs); a console opened afterwards is still recorded', async () => {
    const s = await setup({ options: { lifecycleShutdownWaitMs: 4_000 } });
    const entryId = await idleEntry(s.h);
    const hold = s.launcher.holdNext();
    const opening = s.h.cmd({ name: 'session.openExternal', entryId });
    await hold.reached;
    let stopped = false;
    const stopping = s.h.manager.shutdown().then(() => {
      stopped = true;
    });
    await s.h.settle();
    s.h.timers.advance(3_999);
    await s.h.settle();
    expect(stopped).toBe(false);
    s.h.timers.advance(1);
    await stopping;
    hold.release();
    expect(await opening).toEqual({ pid: PID });
  });

  it('R4-03: a shutdown before the console opens → SERVER_SHUTTING_DOWN, nothing opened', async () => {
    const { h, launcher } = await setup();
    const entryId = await idleEntry(h);
    const gate = Promise.withResolvers<undefined>();
    const reached = Promise.withResolvers<undefined>();
    const launchFor = h.claude.consoleLaunchFor.bind(h.claude);
    h.claude.consoleLaunchFor = async (req) => {
      reached.resolve(undefined);
      await gate.promise;
      return launchFor(req);
    };
    const opening = h.cmdError({ name: 'session.openExternal', entryId });
    await reached.promise;
    const stopping = h.manager.shutdown();
    await h.settle();
    gate.resolve(undefined);
    expect(await opening).toEqual({ code: 'SERVER_SHUTTING_DOWN', params: {} });
    await stopping;
    expect(launcher.opened).toEqual([]);
    expect(h.stores.registry.get(entryId)?.external).toBeNull();
  });

  it('R4-09: a deleted working folder → CWD_NOT_FOUND before the query is closed', async () => {
    const missing = { value: false };
    const { h, launcher } = await setup({
      checkCwd: (cwd) => {
        if (missing.value) return Promise.reject(new CommandError(makeError('CWD_NOT_FOUND', { cwd })));
        return Promise.resolve();
      },
    });
    const entryId = await idleEntry(h);
    missing.value = true;
    expect((await h.cmdError({ name: 'session.openExternal', entryId })).code).toBe('CWD_NOT_FOUND');
    expect(launcher.opened).toEqual([]);
    expect(h.session(entryId).state).not.toBe('exited');
    expect(h.facts(entryId).runState).toBe('idle');
  });
});

// =====================================================================================
// Watch, return, reclaim
// =====================================================================================

describe('watch and return (ADR-104)', () => {
  it('checks every 5 s; ended → import of the console turns (duplicates dropped), handoff items, sleeping', async () => {
    const s = await setup();
    const { h, launcher } = s;
    const entryId = await idleEntry(h);
    const sessionId = sessionIdOf(h, entryId);
    const before = upserts(h, entryId).length;
    await h.cmd({ name: 'session.openExternal', entryId });
    // While external: only the console-safe commands.
    expect((await h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: 'x' } })).code).toBe(
      'SESSION_EXTERNAL',
    );
    expect((await h.cmdError({ name: 'session.continueAfterLimit', entryId, enabled: true })).code).toBe(
      'SESSION_EXTERNAL',
    );

    h.timers.advance(POLL_MS);
    await h.settle();
    expect(launcher.checks).toEqual([{ pid: PID, startedAt: new Date(SAMPLE_TIME) }]);
    expect(pendingMs(h)).toEqual([POLL_MS]);
    expect(h.facts(entryId).runState).toBe('external');

    await consoleEnds(s, entryId);
    // The first turn is in the window too (same virtual time) but already in the log: only the
    // console turn is new.
    const items = upserts(h, entryId).slice(before);
    expect(items.map((i) => [i.kind, i.kind === 'system' ? i.event : null])).toEqual([
      ['system', 'handoff'],
      ['user_message', null],
      ['assistant_text', null],
      ['system', 'handoff'],
    ]);
    const [external, prompt, answer, returned] = items;
    expect(prompt).toMatchObject({ kind: 'user_message', text: { text: FAKE_CONSOLE_PROMPT } });
    expect(answer).toMatchObject({ kind: 'assistant_text', text: fakeConsoleAnswer(FAKE_CONSOLE_PROMPT) });
    expect(returned).toMatchObject({ kind: 'system', event: 'handoff', phase: 'returned', importedItems: 2 });
    const orders = [external, prompt, answer, returned].map((i) => i?.order ?? 0);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(4);
    // The summary showed the ended console while the transcript was read.
    expect(
      h.publisher.summaries.some(
        (x) => x.summary.entryId === entryId && x.summary.external?.running === false,
      ),
    ).toBe(true);
    expect(h.summary(entryId).external).toBeNull();
    expect(h.stores.registry.get(entryId)).toMatchObject({ external: null, lastRunState: 'sleeping' });
    expect(h.timers.pending()).toEqual([]);
    expect(h.manager.inspect(entryId)?.externalWatched).toBe(false);

    // Everything is in the log: a later view (and the next process) continue after it.
    const entry = h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('no entry');
    const logged = h.stores.transcripts.items(entryId, currentConversation(entry).id);
    expect(logged.at(-1)).toMatchObject({ event: 'handoff', phase: 'returned' });
    expect(currentConversation(entry).lastOrder).toBe(returned?.order);

    // The next prompt resumes the same Claude session here.
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    expect(h.backend.starts.at(-1)?.resumeSessionId).toBe(sessionId);
  });

  it('time window: from since − 5 s, messages without a timestamp are dropped', async () => {
    const s = await setup();
    const { h } = s;
    const entryId = await idleEntry(h);
    const sessionId = sessionIdOf(h, entryId);
    // The first turn lies 60 s before the handoff (outside the window).
    h.timers.advance(60_000);
    await h.cmd({ name: 'session.openExternal', entryId });
    const since = Date.parse(h.stores.registry.get(entryId)?.external?.since ?? '');
    const extra = (uuid: string, text: string, at: number | null): HistoryMessage => ({
      type: 'user',
      uuid,
      sessionId,
      message: { role: 'user', content: text },
      parentToolUseId: null,
      timestamp: at === null ? null : new Date(at).toISOString(),
    });
    const read = h.backend.readHistory.bind(h.backend);
    let seen: HistoryMessage[] = [];
    h.backend.readHistory = async (req) => {
      seen = [
        ...(await read(req)),
        extra('5e550000-0000-4000-8000-0000000000a1', 'no time', null),
        extra('5e550000-0000-4000-8000-0000000000a2', 'too old', since - HANDOFF_IMPORT_SLACK_MS - 1),
        extra('5e550000-0000-4000-8000-0000000000a3', 'just before', since - HANDOFF_IMPORT_SLACK_MS),
      ];
      return seen;
    };
    await consoleEnds(s, entryId);
    expect(seen.length).toBeGreaterThan(5);
    const texts = upserts(h, entryId).flatMap((i) => (i.kind === 'user_message' ? [i.text.text] : []));
    expect(texts).toContain('just before');
    expect(texts).toContain(FAKE_CONSOLE_PROMPT);
    expect(texts).not.toContain('no time');
    expect(texts).not.toContain('too old');
    expect(handoffs(h, entryId).at(-1)).toMatchObject({ phase: 'returned', importedItems: 3 });
  });

  it('a read error returns without import (importedItems 0) and logs it', async () => {
    const s = await setup();
    const { h } = s;
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.openExternal', entryId });
    h.backend.readHistory = () => Promise.reject(new Error('transcript locked'));
    await consoleEnds(s, entryId);
    expect(handoffs(h, entryId).map((x) => [x.phase, x.importedItems])).toEqual([
      ['external', 0],
      ['returned', 0],
    ]);
    expect(h.summary(entryId).external).toBeNull();
  });

  it('session.reclaim: running or unknown → EXTERNAL_STILL_RUNNING {pid}; ended → return at once', async () => {
    const { h, launcher } = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.openExternal', entryId });
    expect(await h.cmdError({ name: 'session.reclaim', entryId })).toEqual({
      code: 'EXTERNAL_STILL_RUNNING',
      params: { pid: PID },
    });
    launcher.setState(PID, 'unknown');
    expect((await h.cmdError({ name: 'session.reclaim', entryId })).code).toBe('EXTERNAL_STILL_RUNNING');
    expect(h.facts(entryId).runState).toBe('external');
    launcher.setState(PID, 'ended');
    expect(await h.cmd({ name: 'session.reclaim', entryId })).toEqual({ importedItems: 2 });
    expect(h.facts(entryId).runState).toBe('sleeping');
    // The watch is gone; a second reclaim is a no-op.
    expect(h.timers.pending()).toEqual([]);
    expect(await h.cmd({ name: 'session.reclaim', entryId })).toEqual({ importedItems: 0 });
    expect(handoffs(h, entryId).map((x) => x.phase)).toEqual(['external', 'returned']);
  });
});

// =====================================================================================
// Server restart
// =====================================================================================

describe('server restart with an open handoff (ADR-104)', () => {
  it('running console: stays external and is watched; the shutdown left it alone', async () => {
    const s = await setup();
    const entryId = await idleEntry(s.h);
    await s.h.cmd({ name: 'session.openExternal', entryId });
    const h = await restart(s);
    expect(h.stores.registry.get(entryId)?.external).toMatchObject({ pid: PID });
    expect(h.facts(entryId).runState).toBe('external');
    expect(h.summary(entryId).external).toEqual({ since: SAMPLE_TIME, pid: PID, running: true });
    expect(h.manager.inspect(entryId)?.externalWatched).toBe(true);
    expect(s.launcher.opened).toHaveLength(1);
    s.h = h;
    await consoleEnds(s, entryId);
    expect(handoffs(h, entryId).map((x) => [x.phase, x.importedItems])).toEqual([['returned', 2]]);
  });

  it('ended console: the return runs right at the start', async () => {
    const s = await setup();
    const entryId = await idleEntry(s.h);
    await s.h.cmd({ name: 'session.openExternal', entryId });
    s.launcher.setState(PID, 'ended');
    const h = await restart(s);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    expect(h.summary(entryId).external).toBeNull();
    expect(h.stores.registry.get(entryId)?.external).toBeNull();
    expect(handoffs(h, entryId).map((x) => [x.phase, x.importedItems])).toEqual([['returned', 2]]);
    expect(h.timers.pending()).toEqual([]);
  });

  it('runState external without a handoff record → sleeping at the start', async () => {
    const s = await setup();
    const entryId = await idleEntry(s.h);
    await s.h.cmd({ name: 'session.close', entryId });
    const entry = s.h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('no entry');
    s.h.stores.registry.upsert({ ...entry, lastRunState: 'external' });
    await s.h.manager.shutdown();
    // The shutdown flushes the in-memory state again: write the inconsistent row afterwards.
    s.h.stores.registry.upsert({ ...entry, lastRunState: 'external' });
    const h = await restart(s);
    expect(h.facts(entryId).runState).toBe('sleeping');
  });
});

// =====================================================================================
// session.consoleCommand and secrets
// =====================================================================================

describe('session.consoleCommand and secrets (ADR-104)', () => {
  it('the PowerShell line of the console spec; changes nothing (running, external, archived)', async () => {
    const { h, launcher } = await setup();
    const entryId = await idleEntry(h);
    const sessionId = sessionIdOf(h, entryId);
    const result = await h.cmd({ name: 'session.consoleCommand', entryId });
    const spec = await h.claude.consoleLaunchFor({
      profileId: 'standard',
      entryId,
      cwd: h.stores.registry.get(entryId)?.cwd ?? '',
      resumeSessionId: sessionId,
      model: null,
      permissionMode: 'default',
    });
    expect(result).toEqual({ command: consoleCommandText(spec), sessionId });
    expect(h.facts(entryId).runState).toBe('idle');
    expect(h.session(entryId).state).not.toBe('exited');
    expect(launcher.opened).toEqual([]);
    await h.cmd({ name: 'session.openExternal', entryId });
    expect((await h.cmd({ name: 'session.consoleCommand', entryId })).sessionId).toBe(sessionId);
    expect(h.facts(entryId).runState).toBe('external');
  });

  it('the console env (profile secrets) never reaches a log line, an op, a summary, an item or an error', async () => {
    const SECRET = 'sk-fake-console-secret-4711';
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (line: string) => lines.push(line) });
    const s = await setup({ consoleEnv: { API_TOKEN: SECRET, CLAUDE_CONFIG_DIR: 'D:\\cfg' }, logger });
    const { h, launcher } = s;
    const entryId = await idleEntry(h);

    // The copy command carries the env on purpose (ADR-104) – only in the command result.
    const copy = await h.cmd({ name: 'session.consoleCommand', entryId });
    expect(copy.command).toContain(SECRET);

    launcher.failNext(`Start-Process failed for API_TOKEN=${SECRET} in D:\\cfg`);
    const failed = await h.cmdError({ name: 'session.openExternal', entryId });
    expect(failed.code).toBe('EXTERNAL_CONSOLE_FAILED');
    expect(String(failed.params.reason)).toContain(REDACTED);
    expect(JSON.stringify(failed)).not.toContain(SECRET);

    await h.cmd({ name: 'session.openExternal', entryId });
    await consoleEnds(s, entryId);
    launcher.failNext(SECRET);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    expect(String((await h.cmdError({ name: 'session.openExternal', entryId })).params.reason)).toBe(
      REDACTED,
    );

    const entry = h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('no entry');
    const published = JSON.stringify([
      h.publisher.allOps,
      h.publisher.summaries,
      h.publisher.hostStates,
      h.publisher.notifications,
      h.stores.registry.list(),
      h.stores.transcripts.lines(entryId, currentConversation(entry).id),
      h.errors.map((e) => String(e.error)),
    ]);
    expect(published).not.toContain(SECRET);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.filter((line) => line.includes(SECRET))).toEqual([]);
  });
});
