/**
 * WP-31 – the Phase-2 engine through the real manager with the FakeBackend, the memory stores and a
 * virtual clock: idle sleep from the settings (ADR-105), archive/pin (ADR-106), fast mode, switching
 * to an earlier conversation (ADR-107), git branch (ADR-113), slash-command cache (ADR-108),
 * persistent catalogs/limits (ADR-114), settings effect (ADR-109/117), host-command routing
 * (ADR-101) and the Phase-2 host state. Everything published passes the hub-like validation of the
 * memory publisher (validation 'throw').
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { currentConversation, type Entry, type TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import {
  SAMPLE_TIME,
  sampleConversation,
  sampleEntry,
  sampleFsListing,
  sampleId,
  sampleItems,
  sampleTime,
} from '@shared/samples';
import { eventsScenario } from '../backend/fakeBackend';
import { FAKE_COMMANDS, FAKE_MODELS, FAKE_TERMINAL_COMMANDS } from '../backend/fake/defaults';
import {
  closeGate,
  dslContext,
  frame,
  input,
  events as join,
  streamedText,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
} from '../backend/fake/dsl';
import { openRegistryStore } from '../store/registry';
import { CommandError, type ClientPresence, type HostCommandHandler } from '../sync/ports';
import { toSlashCommands } from './commandCatalog';
import { init, msg, system } from './normalizer/synthetic/build';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './testing/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MINUTE = 60_000;
const harnesses: EngineHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.close();
    expect(h.errors).toEqual([]);
  }
});

async function setup(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const h = await createEngineHarness(options);
  harnesses.push(h);
  return h;
}

/** Restart on the same stores (the old manager is shut down by restart()). */
async function restart(
  h: EngineHarness,
  options: Partial<EngineHarnessOptions> = {},
): Promise<EngineHarness> {
  const index = harnesses.indexOf(h);
  if (index >= 0) harnesses.splice(index, 1);
  expect(h.errors).toEqual([]);
  const next = await h.restart(options);
  harnesses.push(next);
  return next;
}

function client(entryId: EntryId | null, o: Partial<ClientPresence['presence']> = {}, n = 1): ClientPresence {
  return {
    clientId: sampleId('cl', n),
    presence: { focused: true, visible: true, viewingEntryId: entryId, typing: false, ...o },
    lastFocusAt: new Date(Date.parse(SAMPLE_TIME) + n),
    connectedAt: new Date(SAMPLE_TIME),
  };
}

function setPresence(h: EngineHarness, list: ClientPresence[]): void {
  h.publisher.setPresence(list);
  h.manager.onPresenceChanged(list);
}

/** A running entry that finished its first turn (interactive scenario: waits for input, idle). */
async function idleEntry(h: EngineHarness, prompt = 'Reply with exactly: OK'): Promise<EntryId> {
  const entryId = await h.create(prompt);
  await h.waitFor(() => h.facts(entryId).runState === 'idle');
  await h.settle();
  return entryId;
}

function pendingMs(h: EngineHarness): number[] {
  return h.timers.pending().map((t) => t.ms);
}

function sessionsExited(h: EngineHarness, entryId: EntryId): boolean {
  return h.sessions(entryId).every((s) => s.state === 'exited');
}

// =====================================================================================
// Idle sleep (ADR-105)
// =====================================================================================

describe('idle sleep from the settings (ADR-105)', () => {
  it('sleeps after 30 min without presence: close → sleeping, unread kept, process gone', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await idleEntry(h);
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    h.timers.advance(30 * MINUTE - 1);
    await h.settle();
    expect(h.facts(entryId).runState).toBe('idle');
    h.timers.advance(1);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    expect(sessionsExited(h, entryId)).toBe(true);
    expect(h.facts(entryId).unread).toBe(true);
    expect(h.manager.inspect(entryId)?.phase).toBe('dormant');
    expect(h.timers.pending()).toEqual([]);
  });

  it('no sleep while a focused, visible window shows it; the idle time counts from leaving', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await h.create('Reply with exactly: OK');
    setPresence(h, [client(entryId)]);
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.timers.pending()).toEqual([]);
    h.timers.advance(60 * MINUTE);
    // Visible but not focused does not keep it awake.
    setPresence(h, [client(entryId, { focused: false })]);
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    h.timers.advance(20 * MINUTE);
    // Back in focus: no timer; leaving again starts a fresh 30 min.
    setPresence(h, [client(entryId)]);
    expect(h.timers.pending()).toEqual([]);
    setPresence(h, [client(null)]);
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    // Unrelated presence changes keep the start of the idle time.
    h.timers.advance(10 * MINUTE);
    setPresence(h, [client(null, {}, 1), client(null, { focused: false }, 2)]);
    expect(pendingMs(h)).toEqual([20 * MINUTE]);
    h.timers.advance(20 * MINUTE);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
  });

  it('no sleep with an open decision', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.timers.pending()).toEqual([]);
  });

  it('no sleep with a background task', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000003b1' });
    const prompt = c.ids.uuid();
    const task = {
      task_id: 't1',
      task_type: 'local_agent',
      subagent_type: 'general-purpose',
      description: 'x',
    };
    const events = join(
      input(c, prompt, 'work'),
      turnOpen(c, prompt),
      toEvents([frame(c, system(0, 'background_tasks_changed', { tasks: [task] }))]),
      turnClose(c, prompt),
      closeGate(),
    );
    const h = await setup({ sleepPolicy: 'settings', scenario: () => eventsScenario('bg', events) });
    const entryId = await h.create('work');
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.facts(entryId).backgroundTasks).toBe(1);
    expect(h.timers.pending()).toEqual([]);
  });

  it('no sleep with a queued prompt', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000003b2' });
    const first = c.ids.uuid();
    const second = c.ids.uuid();
    const events = join(
      input(c, first, 'one'),
      turnOpen(c, first),
      turnClose(c, first),
      input(c, second, 'two'),
      toEvents([frame(c, msg({ type: 'command_lifecycle', command_uuid: second, state: 'queued' }))]),
      closeGate(),
    );
    const h = await setup({ sleepPolicy: 'settings', scenario: () => eventsScenario('queued', events) });
    const entryId = await h.create('one');
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'two' } });
    await h.settle();
    expect(h.facts(entryId)).toMatchObject({ runState: 'idle', queuedPrompts: 1 });
    expect(h.timers.pending()).toEqual([]);
  });

  it('settings enabled:false and other minutes apply at once (time counted from the idle start)', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await idleEntry(h);
    h.timers.advance(10 * MINUTE);
    await h.cmd({ name: 'settings.update', patch: { idleSleep: { enabled: false, minutes: 30 } } });
    expect(h.timers.pending()).toEqual([]);
    await h.cmd({ name: 'settings.update', patch: { idleSleep: { enabled: true, minutes: 30 } } });
    expect(pendingMs(h)).toEqual([20 * MINUTE]);
    await h.cmd({ name: 'settings.update', patch: { idleSleep: { enabled: true, minutes: 15 } } });
    expect(pendingMs(h)).toEqual([5 * MINUTE]);
    // Already longer idle than 5 min → right away.
    await h.cmd({ name: 'settings.update', patch: { idleSleep: { enabled: true, minutes: 5 } } });
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    expect(sessionsExited(h, entryId)).toBe(true);
  });

  it.each(['ScheduleWakeup', 'CronCreate'])(
    'ADR-121 (R4-02): a %s tool call keeps the process awake; the next process may sleep again',
    async (tool) => {
      const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000003b3' });
      const prompt = c.ids.uuid();
      const toolUseId = c.ids.toolUseId();
      const events = join(
        input(c, prompt, 'check again in an hour'),
        turnOpen(c, prompt),
        toolUseBlock(c, tool, { delaySeconds: 3600, prompt: 'check the deploy' }, { toolUseId }),
        toolResultMessage(c, toolUseId, 'Scheduled.'),
        streamedText(c, 'I will check again in an hour.'),
        turnClose(c, prompt),
        closeGate(),
      );
      const h = await setup({ sleepPolicy: 'settings', scenario: () => eventsScenario('planned', events) });
      const entryId = await h.create('check again in an hour');
      await h.waitFor(() => h.facts(entryId).runState === 'idle');
      await h.settle();
      expect(h.manager.inspect(entryId)?.scheduledTurn).toBe(true);
      expect(h.timers.pending()).toEqual([]);
      // Presence changes and settings re-plan – still no sleep.
      setPresence(h, [client(null)]);
      await h.cmd({ name: 'settings.update', patch: { idleSleep: { enabled: true, minutes: 5 } } });
      expect(h.timers.pending()).toEqual([]);
      h.timers.advance(120 * MINUTE);
      await h.settle();
      expect(h.facts(entryId).runState).toBe('idle');
      expect(sessionsExited(h, entryId)).toBe(false);
      // A new process starts without the mark (the plan died with the old one).
      await h.cmd({ name: 'session.close', entryId });
      await h.cmd({ name: 'session.resume', entryId });
      await h.waitFor(() => h.facts(entryId).runState === 'idle');
      await h.settle();
      expect(h.manager.inspect(entryId)?.scheduledTurn).toBe(false);
      expect(pendingMs(h)).toEqual([5 * MINUTE]);
    },
  );

  it('ADR-121 (R4-02): a /loop prompt keeps the process awake; other tools and prompts do not', async () => {
    const h = await setup({ sleepPolicy: 'settings' });
    const entryId = await idleEntry(h);
    expect(h.manager.inspect(entryId)?.scheduledTurn).toBe(false);
    // Neither an ordinary tool nor a prompt that only mentions /loop.
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'explain /loop to me' } });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(pendingMs(h)).toEqual([30 * MINUTE]);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: '  /loop 40m check the deploy' } });
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.manager.inspect(entryId)?.scheduledTurn).toBe(true);
    expect(h.timers.pending()).toEqual([]);
    h.timers.advance(120 * MINUTE);
    await h.settle();
    expect(h.facts(entryId).runState).toBe('idle');
    expect(sessionsExited(h, entryId)).toBe(false);
  });
});

// =====================================================================================
// Archive and pin (ADR-106)
// =====================================================================================

describe('archive and pin (ADR-106, WP-30 §4.12)', () => {
  it('archive while busy → SESSION_BUSY; nothing changes', async () => {
    const h = await setup();
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    const error = await h.cmdError({ name: 'session.setArchived', entryId, archived: true });
    expect(error).toEqual({ code: 'SESSION_BUSY', params: { entryId } });
    expect(h.summary(entryId).archived).toBe(false);
    expect(h.session(entryId).state).not.toBe('exited');
  });

  it('archive idle → the process ends, notifications cleared, continueAt cleared; read-only until restored', async () => {
    const seeded = sampleEntry({
      id: sampleId('en', 41),
      lastRunState: 'sleeping',
      continueAt: sampleTime(3600),
    });
    const h = await setup({ seed: { entries: [seeded] } });
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });
    expect(h.summary(entryId)).toMatchObject({ archived: true, status: { runState: 'sleeping' } });
    expect(sessionsExited(h, entryId)).toBe(true);
    expect(h.publisher.cleared).toContain(entryId);
    // Idempotent.
    await h.cmd({ name: 'session.setArchived', entryId, archived: true });

    await h.cmd({ name: 'session.setArchived', entryId: seeded.id, archived: true });
    expect(h.stores.registry.get(seeded.id)).toMatchObject({ archived: true, continueAt: null });

    const blocked = [
      { name: 'session.sendPrompt', entryId, prompt: { text: 'hi' } },
      { name: 'session.resume', entryId },
      { name: 'session.interrupt', entryId },
      { name: 'session.setModel', entryId, model: 'opus' },
      { name: 'session.setPermissionMode', entryId, mode: 'plan' },
      { name: 'session.setEffort', entryId, effort: 'low' },
      { name: 'session.setFastMode', entryId, enabled: true },
      { name: 'session.close', entryId },
      { name: 'session.getContext', entryId, detail: 'summary' },
      { name: 'session.refreshModels', entryId },
      { name: 'session.switchConversation', entryId, conversationId: sampleId('cv', 9) },
      { name: 'session.openExternal', entryId },
      { name: 'session.reclaim', entryId },
      { name: 'session.continueAfterLimit', entryId, enabled: true },
      {
        name: 'decision.respond',
        entryId,
        decisionId: sampleId('dc', 1),
        response: { kind: 'permission', response: { behavior: 'allow' } },
      },
    ] as const;
    for (const cmd of blocked) {
      expect([cmd.name, (await h.cmdError(cmd)).code]).toEqual([cmd.name, 'SESSION_ARCHIVED']);
    }
    // Allowed: pin, rename, loadEarlier, consoleCommand (WP-34).
    await h.cmd({ name: 'session.setPinned', entryId, pinned: true });
    await h.cmd({ name: 'session.rename', entryId, title: 'Archived work' });
    const entry = h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('no entry');
    await h.cmd({
      name: 'transcript.loadEarlier',
      entryId,
      conversationId: currentConversation(entry).id,
      beforeOrder: 100,
      limit: 10,
    });
    const copy = await h.cmd({ name: 'session.consoleCommand', entryId });
    expect(copy.sessionId).toBe(h.summary(entryId).sessionId);
    expect(copy.command).toContain('--resume');
    expect(h.summary(entryId)).toMatchObject({ pinned: true, title: 'Archived work', archived: true });
    expect(h.backend.starts).toHaveLength(1);

    // Restore: only the flag; the next prompt starts (resumes) the session again.
    await h.cmd({ name: 'session.setArchived', entryId, archived: false });
    expect(h.summary(entryId).archived).toBe(false);
    expect(h.backend.starts).toHaveLength(1);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    expect(h.backend.starts).toHaveLength(2);
    expect(h.backend.starts[1]?.resumeSessionId).toBe(h.summary(entryId).sessionId);
  });

  it('a prompt that waited for the lifecycle lock never restarts an archived entry', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.close', entryId });
    const archive = h.cmd({ name: 'session.setArchived', entryId, archived: true });
    const prompt = h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: 'late' } });
    await archive;
    expect((await prompt).code).toBe('SESSION_ARCHIVED');
    expect(h.backend.starts).toHaveLength(1);
  });

  it('pin is a flag only (summary and registry), also while running', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setPinned', entryId, pinned: true });
    expect(h.summary(entryId).pinned).toBe(true);
    expect(h.stores.registry.get(entryId)?.pinned).toBe(true);
    expect(h.session(entryId).state).not.toBe('exited');
    await h.cmd({ name: 'session.setPinned', entryId, pinned: false });
    expect(h.summary(entryId).pinned).toBe(false);
  });
});

// =====================================================================================
// Fast mode
// =====================================================================================

describe('fast mode (WP-30 §4.12)', () => {
  it('running: applyFlagSettings({fastMode}) then Entry.fastMode; dormant: stored and passed at the start', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    await h.cmd({ name: 'session.setFastMode', entryId, enabled: true });
    expect(h.session(entryId).controls).toContainEqual({
      method: 'applyFlagSettings',
      args: [{ fastMode: true }],
    });
    expect(h.summary(entryId).fastMode).toBe(true);
    expect(h.stores.registry.get(entryId)?.fastMode).toBe(true);
    await h.cmd({ name: 'session.close', entryId });
    await h.cmd({ name: 'session.setFastMode', entryId, enabled: false });
    expect(h.summary(entryId).fastMode).toBe(false);
    await h.cmd({ name: 'session.resume', entryId });
    expect(h.backend.starts.map((s) => s.fastMode)).toEqual([null, false]);
  });

  it('a failing control call → CLAUDE_CONTROL_FAILED, nothing stored', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000003f1' });
    const prompt = c.ids.uuid();
    const events = join(
      input(c, prompt, 'hello'),
      turnOpen(c, prompt),
      turnClose(c, prompt),
      toEvents([
        [
          'control',
          { method: 'applyFlagSettings', args: [{ fastMode: true }], error: { message: 'no' }, ms: 1 },
        ],
      ]),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('fast-error', events) });
    const entryId = await h.create('hello');
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    const error = await h.cmdError({ name: 'session.setFastMode', entryId, enabled: true });
    expect(error).toEqual({ code: 'CLAUDE_CONTROL_FAILED', params: { method: 'applyFlagSettings' } });
    expect(h.summary(entryId).fastMode).toBeNull();
  });
});

// =====================================================================================
// Earlier conversations (ADR-107)
// =====================================================================================

describe('switchConversation (ADR-107)', () => {
  const CV_OLD = sampleId('cv', 0x71);
  const CV_CUR = sampleId('cv', 0x72);
  const CV_NEW = sampleId('cv', 0x73);
  const S_OLD = '5e550000-0000-4000-8000-000000000711';
  const S_CUR = '5e550000-0000-4000-8000-000000000712';

  function itemsOf(prefix: string, count: number): TranscriptItem[] {
    return Array.from({ length: count }, (_, i) =>
      i % 2 === 0
        ? sampleItems.userMessage({
            id: `00000000-0000-4000-8000-${prefix}${String(i).padStart(4, '0')}`,
            order: i + 1,
          })
        : sampleItems.assistantText({ id: `msg_${prefix}:${String(i)}`, order: i + 1 }),
    );
  }

  function seededEntry(p: Partial<Entry> = {}): Entry {
    return sampleEntry({
      id: sampleId('en', 0x70),
      title: 'Current topic',
      titleSource: 'prompt',
      lastRunState: 'sleeping',
      context: null,
      contextPct: null,
      conversations: [
        sampleConversation({
          id: CV_OLD,
          sessionId: S_OLD,
          startedAt: sampleTime(-7200),
          endedAt: sampleTime(-3600),
          endReason: 'clear',
          title: 'First topic',
          lastOrder: 3,
        }),
        sampleConversation({ id: CV_CUR, sessionId: S_CUR, startedAt: sampleTime(-3600), lastOrder: 2 }),
      ],
      ...p,
    });
  }

  function transcripts(entryId: EntryId) {
    return [
      { entryId, conversationId: CV_OLD, items: itemsOf('0000aaaa', 3) },
      { entryId, conversationId: CV_CUR, items: itemsOf('0000bbbb', 2) },
    ];
  }

  it('ops in order, hub view = client view, registry v2 readable, the next start resumes the target', async () => {
    const entry = seededEntry();
    const h = await setup({ seed: { entries: [entry], transcripts: transcripts(entry.id) } });
    const before = await h.manager.loadView(entry.id);
    if (before === null) throw new Error('no view');
    expect(before.items.map((i) => i.order)).toEqual([1, 2]);
    h.publisher.setViewBase(entry.id, before);
    const published = h.publisher.opsOf(entry.id).length;

    await h.cmd({ name: 'session.switchConversation', entryId: entry.id, conversationId: CV_OLD });

    const ops: SessionOp[] = h.publisher.opsOf(entry.id).slice(published);
    expect(ops.map((op) => op.op)).toEqual([
      'conversation.reset',
      'item.upsert',
      'item.upsert',
      'item.upsert',
      'detail.patch',
    ]);
    expect(ops[0]).toEqual({
      op: 'conversation.reset',
      conversationId: CV_OLD,
      previousConversationId: CV_CUR,
      trigger: 'switch',
      hasEarlier: false,
    });
    const stored = h.stores.registry.get(entry.id);
    if (stored === undefined) throw new Error('no entry');
    expect(stored.conversations.map((c) => [c.id, c.endReason, c.endedAt === null])).toEqual([
      [CV_CUR, 'switched', false],
      [CV_OLD, null, true],
    ]);
    expect(stored.conversations[0]?.title).toBe('Current topic');
    expect(stored).toMatchObject({ title: 'First topic', titleSource: 'ai' });
    expect(currentConversation(stored).id).toBe(CV_OLD);
    expect(ops[4]).toEqual({
      op: 'detail.patch',
      patch: { conversationId: CV_OLD, conversations: stored.conversations },
    });
    // The tail was not written again.
    expect(h.stores.transcripts.lines(entry.id, CV_OLD)).toHaveLength(3);

    // Hub view (applySessionOp on the snapshot) = the engine's mirror = a fresh load from the log.
    const hub = h.publisher.view(entry.id);
    const mirror = await h.manager.loadView(entry.id);
    if (hub === null || mirror === null) throw new Error('no view');
    expect(hub).toEqual({ ...mirror, seq: hub.seq });
    expect(hub.items.map((i) => i.order)).toEqual([1, 2, 3]);
    expect(hub).toMatchObject({ conversationId: CV_OLD, hasEarlier: false, decisions: [] });
    h.manager.onSubscribersChanged(entry.id, 0);
    const fresh = await h.manager.loadView(entry.id);
    expect(fresh).toMatchObject({ conversationId: CV_OLD, hasEarlier: false, items: hub.items });
    expect(fresh?.detail.conversations).toEqual(hub.detail.conversations);

    // The next prompt resumes the Claude session of the target.
    await h.cmd({
      name: 'session.sendPrompt',
      entryId: entry.id,
      prompt: { text: 'Reply with exactly: OK' },
    });
    expect(h.backend.starts[0]?.resumeSessionId).toBe(S_OLD);
    await h.settle();

    // Registry file v2 (enum 'switched') survives a write and a re-read.
    const home = await mkdtemp(path.join(os.tmpdir(), 'parallax-test-wp31-'));
    try {
      const file = await openRegistryStore({ home });
      file.upsert(stored);
      await file.close();
      const raw: unknown = JSON.parse(await readFile(path.join(home, 'sessions.json'), 'utf8'));
      expect(raw).toMatchObject({ schemaVersion: 2 });
      const reopened = await openRegistryStore({ home });
      expect(reopened.get(entry.id)).toEqual(stored);
      await reopened.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }

    // …and after an engine restart on the same stores.
    const h2 = await restart(h);
    expect(h2.summary(entry.id).sessionId).toBe(S_OLD);
    expect(h2.stores.registry.get(entry.id)?.conversations[0]?.endReason).toBe('switched');
  });

  it('a custom title stays; hasEarlier when the tail is longer than the snapshot', async () => {
    const entry = seededEntry({ title: 'My name', titleSource: 'custom' });
    const many = itemsOf('0000cccc', 160);
    const h = await setup({
      seed: {
        entries: [entry],
        transcripts: [{ entryId: entry.id, conversationId: CV_OLD, items: many }],
      },
    });
    await h.cmd({ name: 'session.switchConversation', entryId: entry.id, conversationId: CV_OLD });
    const reset = h.publisher.opsOf(entry.id).find((op) => op.op === 'conversation.reset');
    expect(reset).toMatchObject({ hasEarlier: true });
    expect(h.summary(entry.id)).toMatchObject({ title: 'My name', titleSource: 'custom' });
    expect(h.stores.registry.get(entry.id)?.conversations[0]?.title).toBe('My name');
  });

  it('errors: CONVERSATION_NOT_FOUND, SESSION_NOT_STARTED, SESSION_BUSY; the current one is a no-op', async () => {
    const entry = seededEntry({
      conversations: [
        sampleConversation({ id: CV_NEW, sessionId: null, endedAt: sampleTime(-10), endReason: 'clear' }),
        sampleConversation({ id: CV_CUR, sessionId: S_CUR }),
      ],
    });
    const h = await setup({ seed: { entries: [entry] } });
    const unknown = await h.cmdError({
      name: 'session.switchConversation',
      entryId: entry.id,
      conversationId: sampleId('cv', 0x99),
    });
    expect(unknown).toEqual({
      code: 'CONVERSATION_NOT_FOUND',
      params: { conversationId: sampleId('cv', 0x99) },
    });
    const notStarted = await h.cmdError({
      name: 'session.switchConversation',
      entryId: entry.id,
      conversationId: CV_NEW,
    });
    expect(notStarted.code).toBe('SESSION_NOT_STARTED');
    const ops = h.publisher.opsOf(entry.id).length;
    await h.cmd({ name: 'session.switchConversation', entryId: entry.id, conversationId: CV_CUR });
    expect(h.publisher.opsOf(entry.id)).toHaveLength(ops);
    expect(h.stores.registry.get(entry.id)?.conversations.map((c) => c.id)).toEqual([CV_NEW, CV_CUR]);
  });

  it('R4-08: a scheduled "continue" belongs to the conversation that is left – the switch drops it', async () => {
    const entry = seededEntry({ continueAt: sampleTime(600) });
    const h = await setup({ seed: { entries: [entry], transcripts: transcripts(entry.id) } });
    expect(h.manager.inspect(entry.id)?.continueScheduled).toBe(true);
    expect(h.facts(entry.id).wakeupAt).toBe(sampleTime(600));
    await h.cmd({ name: 'session.switchConversation', entryId: entry.id, conversationId: CV_OLD });
    expect(h.stores.registry.get(entry.id)?.continueAt).toBeNull();
    expect(h.facts(entry.id).wakeupAt).toBeNull();
    expect(h.manager.inspect(entry.id)?.continueScheduled).toBe(false);
    h.timers.advance(600_000);
    await h.settle();
    expect(h.backend.starts).toEqual([]);
  });

  it('SESSION_BUSY with an open decision (the process keeps running)', async () => {
    const entry = seededEntry();
    const h = await setup({ seed: { entries: [entry], transcripts: transcripts(entry.id) } });
    await h.cmd({ name: 'session.sendPrompt', entryId: entry.id, prompt: { text: 'fake:bash' } });
    await h.waitFor(() => h.facts(entry.id).decisions.permission === 1);
    const error = await h.cmdError({
      name: 'session.switchConversation',
      entryId: entry.id,
      conversationId: CV_OLD,
    });
    expect(error).toEqual({ code: 'SESSION_BUSY', params: { entryId: entry.id } });
    expect(currentConversation(h.stores.registry.get(entry.id) ?? entry).id).toBe(CV_CUR);
    expect(h.session(entry.id).state).not.toBe('exited');
  });
});

// =====================================================================================
// Git branch (ADR-113)
// =====================================================================================

describe('git branch (ADR-113)', () => {
  it('read after readiness, persisted; after a restart from the registry', async () => {
    let branch: string | null = 'feature/x';
    const h = await setup({ gitBranch: () => Promise.resolve(branch) });
    const entryId = await idleEntry(h);
    await h.waitFor(() => h.summary(entryId).gitBranch === 'feature/x');
    expect(h.stores.registry.get(entryId)?.gitBranch).toBe('feature/x');
    branch = 'other';
    const h2 = await restart(h);
    expect(h2.summary(entryId).gitBranch).toBe('feature/x');
    expect(h2.manager.inspect(entryId)?.gitBranch).toBe('feature/x');
  });

  it('every 60 s only while a visible window shows the entry (dormant too); at once on a focus change', async () => {
    const entry = sampleEntry({ id: sampleId('en', 0x60), gitBranch: null, lastRunState: 'sleeping' });
    const calls: string[] = [];
    const h = await setup({
      seed: { entries: [entry] },
      options: { gitRefreshMs: MINUTE },
      gitBranch: (cwd) => {
        calls.push(cwd);
        return Promise.resolve(`b${String(calls.length)}`);
      },
    });
    h.timers.advance(5 * MINUTE);
    expect(h.timers.pending()).toEqual([]);
    expect(calls).toEqual([]);
    // Visible, not focused: the 60-s cadence only.
    setPresence(h, [client(entry.id, { focused: false })]);
    expect(pendingMs(h)).toEqual([MINUTE]);
    expect(calls).toEqual([]);
    h.timers.advance(MINUTE);
    await h.waitFor(() => h.summary(entry.id).gitBranch === 'b1');
    expect(calls).toEqual([entry.cwd]);
    expect(pendingMs(h)).toEqual([MINUTE]);
    // Focus change onto the entry → at once.
    setPresence(h, [client(entry.id)]);
    await h.waitFor(() => h.summary(entry.id).gitBranch === 'b2');
    // Same focus again → nothing new.
    setPresence(h, [client(entry.id, { typing: true })]);
    await h.settle();
    expect(calls).toHaveLength(2);
    // Nobody looks → no timer.
    setPresence(h, [client(null)]);
    expect(h.timers.pending()).toEqual([]);
    h.timers.advance(5 * MINUTE);
    await h.settle();
    expect(calls).toHaveLength(2);
    expect(h.stores.registry.get(entry.id)?.gitBranch).toBe('b2');
  });
});

// =====================================================================================
// Slash-command catalog (ADR-108)
// =====================================================================================

describe('slash-command catalog (ADR-108)', () => {
  it('supportedCommands after readiness → detail.commands + cache; a dormant entry loads it after a restart', async () => {
    const h = await setup();
    const entryId = await idleEntry(h);
    const expected = toSlashCommands(FAKE_COMMANDS);
    await h.waitFor(() => h.stores.commandCatalogs.saves.length > 0);
    expect(h.stores.commandCatalogs.saves.at(-1)).toEqual({ entryId, commands: expected });
    const view = await h.manager.loadView(entryId);
    expect(view?.detail.commands).toEqual(expected);
    // FakeBackend init carries the terminal-only commands.
    expect(view?.detail.init?.terminalSlashCommands).toEqual([...FAKE_TERMINAL_COMMANDS]);
    const h2 = await restart(h);
    const dormant = await h2.manager.loadView(entryId);
    expect(dormant?.detail.commands).toEqual(expected);
    expect(h2.backend.starts).toEqual([]);
  });

  it('commands_changed of the normalizer replaces the cache too (the last list wins)', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000008c1' });
    const prompt = c.ids.uuid();
    const events = join(
      input(c, prompt, 'hi'),
      turnOpen(c, prompt),
      toEvents([
        frame(c, system(0, 'commands_changed', { commands: [{ name: 'deploy', description: 'Deploy it' }] })),
      ]),
      turnClose(c, prompt),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('commands', events) });
    const entryId = await h.create('hi');
    await h.waitFor(() =>
      h.stores.commandCatalogs.saves.some((s) => s.commands.some((x) => x.name === 'deploy')),
    );
    expect(h.stores.commandCatalogs.saves.every((s) => s.entryId === entryId)).toBe(true);
  });
});

// =====================================================================================
// Catalogs and limits (ADR-114)
// =====================================================================================

function rateLimitEvents(apiKeySource: string | null): ReturnType<typeof join> {
  const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000009a1' });
  const prompt = c.ids.uuid();
  return join(
    input(c, prompt, 'hi'),
    turnOpen(c, prompt),
    toEvents([
      ...(apiKeySource === null ? [] : [frame(c, init(0, { apiKeySource }))]),
      frame(
        c,
        msg({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed_warning',
            resetsAt: 1_792_051_200,
            rateLimitType: 'five_hour',
            utilization: 0.85,
          },
        }),
      ),
    ]),
    turnClose(c, prompt),
    closeGate(),
  );
}

describe('model catalogs and account limits persistent (ADR-114)', () => {
  it('after a restart: host state has the limits at once, a dormant entry has the real model list', async () => {
    const h = await setup({ scenario: () => eventsScenario('limits', rateLimitEvents(null)) });
    const entryId = await h.create('hi');
    await h.settle();
    expect(h.manager.hostState().accountLimits.standard).toMatchObject({ utilization: 0.85 });
    expect(h.stores.catalogs.limits().standard).toMatchObject({ utilization: 0.85 });
    const values = FAKE_MODELS.map((m) => m.value);
    expect(h.stores.catalogs.models().standard?.options.map((o) => o.value)).toEqual(values);
    const h2 = await restart(h);
    expect(h2.manager.hostState().accountLimits.standard).toMatchObject({
      status: 'allowed_warning',
      utilization: 0.85,
    });
    const { models } = await h2.cmd({ name: 'session.refreshModels', entryId });
    expect(models.map((m) => m.value)).toEqual(values);
    const view = await h2.manager.loadView(entryId);
    expect(view?.detail.models?.map((m) => m.value)).toEqual(values);
  });

  it('limits only from subscription sessions (apiKeySource none)', async () => {
    const h = await setup({
      scenario: () => eventsScenario('limits-api', rateLimitEvents('ANTHROPIC_API_KEY')),
    });
    const entryId = await h.create('hi');
    await h.settle();
    expect(h.summary(entryId).apiKeySource).toBe('ANTHROPIC_API_KEY');
    expect(h.facts(entryId).rateLimitedUntil).toBeNull();
    expect(h.manager.hostState().accountLimits).toEqual({});
    expect(h.stores.catalogs.limits()).toEqual({});
  });
});

// =====================================================================================
// Settings effect, host commands, host state
// =====================================================================================

describe('settings effect (ADR-109, ADR-117)', () => {
  it('promptSuggestions from the settings at the next start; onSettingsChanged(prev, next) + host state', async () => {
    const changes: [boolean, boolean][] = [];
    const h = await setup({
      onSettingsChanged: (prev, next) => changes.push([prev.promptSuggestions, next.promptSuggestions]),
    });
    const before = h.publisher.hostStates.length;
    await h.cmd({ name: 'settings.update', patch: { promptSuggestions: true } });
    expect(changes).toEqual([[false, true]]);
    expect(h.publisher.hostStates.length).toBe(before + 1);
    expect(h.publisher.hostStates.at(-1)?.settings.promptSuggestions).toBe(true);
    await idleEntry(h);
    expect(h.backend.starts[0]?.promptSuggestions).toBe(true);
  });

  it('a throwing onSettingsChanged is reported, the command still succeeds', async () => {
    const h = await setup({
      onSettingsChanged: () => {
        throw new Error('integration broke');
      },
    });
    const { settings } = await h.cmd({ name: 'settings.update', patch: { theme: 'light' } });
    expect(settings.theme).toBe('light');
    expect(h.errors.map((e) => e.context)).toEqual(['onSettingsChanged']);
    h.errors.length = 0;
  });

  it('do not disturb: an away window gets the in-app hint instead of a system notification', async () => {
    const away = client(null, { focused: false, visible: false });
    const h = await setup({ presence: [away] });
    await h.cmd({
      name: 'settings.update',
      patch: { notifications: { ...h.manager.hostState().settings.notifications, doNotDisturb: true } },
    });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(h.publisher.notifications.map((n) => [n.notification.kind, n.notification.delivery])).toEqual([
      ['permission', 'in_app'],
    ]);
  });
});

describe('host commands (ADR-101)', () => {
  it('routed by name; CommandErrors pass through; unexpected → INTERNAL_ERROR; no handler → NOT_IMPLEMENTED', async () => {
    const seen: string[] = [];
    const fsHandler: HostCommandHandler = {
      names: ['fs.listDirectory'],
      handle: (cmd, ctx) => {
        seen.push(`${cmd.name}:${ctx.clientId}`);
        return Promise.resolve(sampleFsListing());
      },
    };
    const profiles: HostCommandHandler = {
      names: ['profile.delete', 'profile.setDefault'],
      handle: (cmd) => {
        seen.push(cmd.name);
        if (cmd.name === 'profile.delete')
          return Promise.reject(new CommandError(makeError('PROFILE_IN_USE', { count: 2 })));
        return Promise.reject(new Error('bug'));
      },
    };
    const h = await setup({ hostCommands: [fsHandler, profiles] });
    expect(await h.cmd({ name: 'fs.listDirectory', path: null })).toEqual(sampleFsListing());
    expect(await h.cmdError({ name: 'profile.delete', profileId: sampleId('pf', 1) })).toEqual({
      code: 'PROFILE_IN_USE',
      params: { count: 2 },
    });
    expect((await h.cmdError({ name: 'profile.setDefault', profileId: sampleId('pf', 1) })).code).toBe(
      'INTERNAL_ERROR',
    );
    expect(h.errors.map((e) => e.context)).toEqual(['command profile.setDefault']);
    h.errors.length = 0;
    expect(await h.cmdError({ name: 'profile.test', profileId: 'standard' })).toEqual({
      code: 'NOT_IMPLEMENTED',
      params: { command: 'profile.test' },
    });
    expect(seen).toEqual([`fs.listDirectory:${sampleId('cl', 1)}`, 'profile.delete', 'profile.setDefault']);
  });

  it('without handlers every host command → NOT_IMPLEMENTED', async () => {
    const h = await setup();
    expect((await h.cmdError({ name: 'profile.get', profileId: 'standard' })).code).toBe('NOT_IMPLEMENTED');
    expect((await h.cmdError({ name: 'fs.listDirectory', path: 'D:\\' })).code).toBe('NOT_IMPLEMENTED');
  });
});

describe('host state (Phase 2)', () => {
  it('port, systemIntegration, entryCount per profile (archived included), extra warnings', async () => {
    let port: number | null = null;
    const warning = {
      id: 'system:autostart',
      error: makeError('AUTOSTART_FAILED', { reason: 'x' }),
      at: SAMPLE_TIME,
    };
    const h = await setup({
      port: () => port,
      systemIntegration: true,
      extraWarnings: () => [warning],
    });
    expect(h.manager.hostState()).toMatchObject({ port: null, systemIntegration: true });
    port = 4711;
    const a = await h.create(null);
    await h.create(null);
    await h.cmd({ name: 'session.setArchived', entryId: a, archived: true });
    const host = h.manager.hostState();
    expect(host.port).toBe(4711);
    expect(host.profiles.find((p) => p.id === 'standard')?.entryCount).toBe(2);
    expect(host.warnings).toContainEqual(warning);
    // Creating an entry published the new count at once.
    expect(h.publisher.hostStates.at(-1)?.profiles[0]?.entryCount).toBe(2);
    h.manager.publishHostState();
    expect(h.publisher.hostStates.at(-1)).toEqual(host);
  });

  it('defaults without WP-40 wiring: port null, systemIntegration false, entryCount 0', async () => {
    const h = await setup();
    expect(h.manager.hostState()).toMatchObject({ port: null, systemIntegration: false });
    expect(h.manager.hostState().profiles[0]?.entryCount).toBe(0);
  });
});
