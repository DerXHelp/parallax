/**
 * WP-13 §5.2 – engine behaviour beyond the recorded fixtures: synthetic engine scenarios of the
 * FakeBackend (crash, startup failures, parallel/aborted decisions), auto-retry with manual timers
 * (no wall clock), first click wins, restart with an open plan decision, restart facts, the
 * loadView race, presence/notifications, orphans and shutdown.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { currentConversation, type Decision, type ToolCallItem, type TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import {
  sampleContextGauge,
  sampleConversation,
  sampleEntry,
  sampleId,
  sampleItems,
  SAMPLE_TIME,
} from '@shared/samples';
import { eventsScenario, fixtureScenario, type FakeScenario } from '../backend/fakeBackend';
import {
  closeGate,
  crash,
  dslContext,
  frame,
  input,
  events as join,
  permissionStep,
  textTurn,
  toEvents,
  toolUseBlock,
  turnClose,
  turnOpen,
} from '../backend/fake/dsl';
import { init, msg, system } from './normalizer/synthetic/build';
import { FAKE_MODELS } from '../backend/fake/defaults';
import { FAKE_SCENARIOS } from '../backend/fake/synthetic';
import { loadFixtureScenario } from '../backend/fake/testing';
import type { FixtureEvent } from '../backend/fixture';
import { AsyncQueue } from '../backend/lib/asyncQueue';
import type { BackendEvent } from '../backend/types';
import type { ClientPresence, TranscriptStore } from '../sync/ports';
import {
  HARNESS_CLIENT_ID,
  createEngineHarness,
  type EngineHarness,
  type EngineHarnessOptions,
} from './testing/harness';

// Whole-engine runs: generous per-test bound for parallel load (the logic itself uses no wall clock).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

function synthetic(name: string): FixtureEvent[] {
  const events = FAKE_SCENARIOS[name];
  if (events === undefined) throw new Error(`unknown scenario ${name}`);
  return [...events];
}

function scenarios(...list: FakeScenario[]): EngineHarnessOptions['scenario'] {
  return (_req, n) => list[Math.min(n, list.length - 1)] ?? list[0] ?? eventsScenario('empty', []);
}

function upserts(ops: readonly SessionOp[]): TranscriptItem[] {
  return ops.flatMap((op) => (op.op === 'item.upsert' ? [op.item] : []));
}

function errorItems(h: EngineHarness, entryId: EntryId) {
  return upserts(h.publisher.opsOf(entryId)).flatMap((i) =>
    i.kind === 'system' && i.event === 'error' ? [i] : [],
  );
}

function lastToolCall(h: EngineHarness, entryId: EntryId, toolUseId: string): ToolCallItem | undefined {
  return upserts(h.publisher.opsOf(entryId))
    .filter((i): i is ToolCallItem => i.kind === 'tool_call' && i.toolUseId === toolUseId)
    .at(-1);
}

function outcomes(h: EngineHarness, entryId: EntryId) {
  return h.publisher.opsOf(entryId).flatMap((op) => (op.op === 'decision.resolved' ? [op.outcome] : []));
}

function viewer(entryId: EntryId | null, o: Partial<ClientPresence['presence']> = {}, n = 1): ClientPresence {
  return {
    clientId: sampleId('cl', n),
    presence: { focused: true, visible: true, viewingEntryId: entryId, typing: false, ...o },
    lastFocusAt: new Date(Date.parse(SAMPLE_TIME) + n),
    connectedAt: new Date(SAMPLE_TIME),
  };
}

// =====================================================================================
// Crash, startup failures (§3.5.12)
// =====================================================================================

describe('crash', () => {
  it('crash-mid-turn: error CLAUDE_PROCESS_CRASHED, px error item, lastError, streaming item closed, no retry', async () => {
    const h = await setup({ scenario: () => eventsScenario('crash-mid-turn', synthetic('crash-mid-turn')) });
    const entryId = await h.create('Write a long answer');
    await h.waitFor(() => h.facts(entryId).runState === 'error');
    await h.settle();
    expect(h.facts(entryId).errorCode).toBe('CLAUDE_PROCESS_CRASHED');
    expect(h.summary(entryId).lastError?.code).toBe('CLAUDE_PROCESS_CRASHED');
    const errors = errorItems(h, entryId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.params).toEqual({ exitCode: 1, signal: null });
    expect(errors[0]?.id).toMatch(/^px:cv_[0-9a-f]{32}:\d+$/);
    // The streamed text was finalized (process_exit) and logged; nothing streams any more.
    const entry = h.stores.registry.get(entryId);
    const logged = h.stores.transcripts.items(entryId, currentConversation(entry ?? sampleEntry()).id);
    const text = logged.find((i) => i.kind === 'assistant_text');
    expect(text).toMatchObject({ streaming: false, aborted: true });
    expect(h.manager.inspect(entryId)).toMatchObject({ phase: 'dormant', retryScheduled: false });
    expect(h.timers.pending()).toEqual([]);
    expect(h.stores.processes.records()).toEqual([]);
  });

  it('crash-awaiting-decision: the open decision is cancelled with process_exit, the tool call interrupted', async () => {
    const h = await setup({
      scenario: () => eventsScenario('crash-awaiting-decision', synthetic('crash-awaiting-decision')),
    });
    const entryId = await h.create('Create the build folder');
    await h.waitFor(() => h.facts(entryId).runState === 'error');
    await h.settle();
    expect(outcomes(h, entryId)).toEqual([{ type: 'cancelled', reason: 'process_exit' }]);
    const call = lastToolCall(h, entryId, 'toolu_fake_crash_awaiting');
    expect(call?.status).toBe('interrupted');
    expect(call?.decision?.outcome).toEqual({ type: 'cancelled', reason: 'process_exit' });
    expect(h.facts(entryId).decisions).toMatchObject({ permission: 0, expired: 0 });
    expect(h.manager.inspect(entryId)?.retryScheduled).toBe(false);
    expect(h.stores.decisions.records(entryId).every((r) => r.outcome !== null && r.decision === null)).toBe(
      true,
    );
  });

  it('queued-then-crash: the undelivered prompt becomes a PROMPT_NOT_DELIVERED item, never resent', async () => {
    const h = await setup({
      scenario: () => eventsScenario('queued-then-crash', synthetic('queued-then-crash')),
    });
    const entryId = await h.create('Run the long build');
    await h.settle();
    const [decision] = await h.decisions(entryId);
    if (decision === undefined) throw new Error('no decision');
    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'permission', response: { behavior: 'allow' } },
    });
    await h.settle();
    const { messageUuid } = await h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'And then the tests' },
    });
    await h.waitFor(() => h.facts(entryId).runState === 'error');
    await h.settle();
    const errors = errorItems(h, entryId);
    const undelivered = errors.find((e) => e.error.code === 'PROMPT_NOT_DELIVERED');
    expect(undelivered?.error.params).toEqual({ messageUuid, preview: 'And then the tests' });
    expect(errors.map((e) => e.error.code)).toEqual(['PROMPT_NOT_DELIVERED', 'CLAUDE_PROCESS_CRASHED']);
    expect(h.facts(entryId).queuedPrompts).toBe(0);
    expect(h.backend.starts).toHaveLength(1);
    expect(h.manager.inspect(entryId)?.retryScheduled).toBe(false);
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);
  });
});

describe('startup failures', () => {
  it('startup-held-elsewhere → error SESSION_HELD_ELSEWHERE, one error item, lastError, no retry', async () => {
    const h = await setup({
      scenario: () => eventsScenario('startup-held-elsewhere', synthetic('startup-held-elsewhere')),
    });
    const entryId = await h.create('Continue the work');
    await h.waitFor(() => h.manager.inspect(entryId)?.phase === 'dormant');
    await h.settle();
    expect(h.facts(entryId)).toMatchObject({ runState: 'error', errorCode: 'SESSION_HELD_ELSEWHERE' });
    expect(h.summary(entryId).lastError?.code).toBe('SESSION_HELD_ELSEWHERE');
    expect(errorItems(h, entryId).map((e) => e.error.code)).toEqual(['SESSION_HELD_ELSEWHERE']);
    expect(h.manager.inspect(entryId)?.retryScheduled).toBe(false);
    expect(h.timers.pending()).toEqual([]);
  });

  it('setup-auth-error → error CLAUDE_AUTH_FAILED (stays after close), lastError, no retry', async () => {
    const h = await setup({
      scenario: () => eventsScenario('setup-auth-error', synthetic('setup-auth-error')),
    });
    const entryId = await h.create('Hello');
    await h.settle();
    expect(h.facts(entryId)).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_AUTH_FAILED' });
    expect(h.summary(entryId).lastError?.code).toBe('CLAUDE_AUTH_FAILED');
    await h.cmd({ name: 'session.close', entryId });
    expect(h.facts(entryId)).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_AUTH_FAILED' });
    expect(h.manager.inspect(entryId)?.retryScheduled).toBe(false);
  });

  it('launchSpecFor fails → error with its code, px item, the command fails (create returns messageUuid null)', async () => {
    const h = await setup();
    h.claude.setLaunchError(makeError('CLAUDE_NOT_FOUND'));
    const result = await h.cmd({ name: 'session.create', cwd: 'D:\\work\\x', prompt: { text: 'Hi' } });
    expect(result.messageUuid).toBeNull();
    expect(h.facts(result.entryId)).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_NOT_FOUND' });
    expect(errorItems(h, result.entryId).map((e) => e.error.code)).toEqual(['CLAUDE_NOT_FOUND']);
    const error = await h.cmdError({ name: 'session.resume', entryId: result.entryId });
    expect(error.code).toBe('CLAUDE_NOT_FOUND');
    expect(h.backend.starts).toHaveLength(0);
    // Two failed starts → two items with increasing orders in the same conversation.
    const orders = errorItems(h, result.entryId).map((e) => e.order);
    expect(orders).toEqual([1, 2]);
    h.claude.setLaunchError(null);
    await h.cmd({ name: 'session.resume', entryId: result.entryId });
    expect(h.backend.starts[0]?.resumeSessionId).toBeNull();
  });
});

// =====================================================================================
// Auto-retry (ADR-025) with manual timers
// =====================================================================================

describe('auto-retry', () => {
  const crashIdle = (): FakeScenario => eventsScenario('crash-idle', crash(3));

  it('idle crash → restarts after 2 s, 10 s, 30 s, at most 3 in a row', async () => {
    const h = await setup({
      scenario: scenarios(eventsScenario('idle-crash', synthetic('idle-crash')), crashIdle()),
    });
    const entryId = await h.create('Reply with exactly: OK');
    for (const delay of [2_000, 10_000, 30_000]) {
      await h.waitFor(() => h.timers.pending().length === 1);
      expect(h.timers.pending()[0]?.ms).toBe(delay);
      expect(h.facts(entryId).errorCode).toBe('CLAUDE_PROCESS_CRASHED');
      const starts = h.backend.starts.length;
      h.timers.advance(delay - 1);
      expect(h.backend.starts).toHaveLength(starts);
      h.timers.advance(1);
      await h.waitFor(() => h.backend.starts.length === starts + 1);
      expect(h.backend.starts.at(-1)?.resumeSessionId).toBe('5e550000-0000-4000-8000-0000000000a3');
    }
    await h.waitFor(
      () => h.manager.inspect(entryId)?.phase === 'dormant' && h.facts(entryId).runState === 'error',
    );
    await h.settle();
    expect(h.timers.pending()).toEqual([]);
    expect(h.manager.inspect(entryId)?.retryAttempts).toBe(3);
    expect(h.backend.starts).toHaveLength(4);
  });

  it('a successful turn resets the counter; a manual resume cancels the timer', async () => {
    const idleCrash = eventsScenario('idle-crash', synthetic('idle-crash'));
    const h = await setup({ scenario: scenarios(idleCrash, idleCrash, idleCrash) });
    const entryId = await h.create('Reply with exactly: OK');
    await h.waitFor(() => h.timers.pending().length === 1);
    h.timers.advance(2_000);
    await h.waitFor(() => h.backend.starts.length === 2);
    await h.settle();
    // The restarted process waits at its input gate: a successful turn, then the idle crash again.
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await h.waitFor(() => h.timers.pending().length === 1);
    expect(h.timers.pending()[0]?.ms).toBe(2_000);
    expect(h.manager.inspect(entryId)?.retryAttempts).toBe(1);
    // Manual resume: timer gone, the start happens now.
    await h.cmd({ name: 'session.resume', entryId });
    expect(h.timers.pending()).toEqual([]);
    expect(h.backend.starts).toHaveLength(3);
    h.timers.advance(60_000);
    await h.settle();
    expect(h.backend.starts).toHaveLength(3);
  });

  it('a process that ran ≥ stableMs counts as stable (counter back to 0)', async () => {
    const h = await setup({
      scenario: scenarios(
        eventsScenario('idle-crash', synthetic('idle-crash')),
        eventsScenario('wait', input(dslContext(), sampleUuidLike(), 'never')),
      ),
    });
    const entryId = await h.create('Reply with exactly: OK');
    await h.waitFor(() => h.timers.pending().length === 1);
    h.timers.advance(2_000);
    await h.waitFor(() => h.backend.starts.length === 2);
    await h.settle();
    h.timers.advance(300_000);
    h.session(entryId).crash(3);
    await h.waitFor(() => h.timers.pending().length === 1);
    expect(h.timers.pending()[0]?.ms).toBe(2_000);
  });

  it('autoRetry: false never restarts', async () => {
    const h = await setup({
      scenario: () => eventsScenario('idle-crash', synthetic('idle-crash')),
      options: { autoRetry: false },
    });
    const entryId = await h.create('Reply with exactly: OK');
    await h.waitFor(() => h.facts(entryId).runState === 'error');
    await h.settle();
    expect(h.timers.pending()).toEqual([]);
  });
});

function sampleUuidLike(): string {
  return '00000000-0000-4000-8000-00000000ffff';
}

// =====================================================================================
// Decisions: parallel, aborted, first click wins
// =====================================================================================

describe('decisions', () => {
  it('parallel-decisions: two open subagent decisions, oldestKind, any answer order, notification per new one', async () => {
    const h = await setup({
      scenario: () => eventsScenario('parallel-decisions', synthetic('parallel-decisions')),
    });
    const other = viewer(null, {}, 2);
    h.publisher.setPresence([other]);
    const entryId = await h.create('Run both steps in parallel');
    await h.settle();
    const open = (await h.decisions(entryId)).filter((d) => d.state === 'open');
    expect(open).toHaveLength(2);
    for (const d of open) expect(d.requester).toMatchObject({ kind: 'subagent' });
    expect(open.map((d) => d.requester.kind === 'subagent' && d.requester.description)).toEqual([
      'Worker a',
      'Worker b',
    ]);
    expect(h.facts(entryId).decisions).toMatchObject({ permission: 2, oldestKind: 'permission' });
    const permissionNotes = h.publisher.notifications.filter((n) => n.notification.kind === 'permission');
    expect(permissionNotes).toHaveLength(2);
    expect(
      permissionNotes.every((n) => n.clientId === other.clientId && n.notification.delivery === 'in_app'),
    ).toBe(true);
    // Answer b first, then a.
    for (const d of [...open].reverse()) {
      await h.cmd({
        name: 'decision.respond',
        entryId,
        decisionId: d.id,
        response: { kind: 'permission', response: { behavior: 'allow' } },
      });
    }
    await h.settle();
    expect(h.facts(entryId).decisions.permission).toBe(0);
    expect(h.publisher.cleared).toContain(entryId);
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);
  });

  it('abort-decision: the CLI cancels → card gone (signal_aborted), a later answer → DECISION_ALREADY_RESOLVED', async () => {
    const h = await setup({ scenario: () => eventsScenario('abort-decision', synthetic('abort-decision')) });
    const entryId = await h.create('Clean the build folder');
    await h.settle();
    const created = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'decision.upsert' ? [op.decision] : []));
    expect(created).toHaveLength(1);
    expect(outcomes(h, entryId)).toEqual([{ type: 'cancelled', reason: 'signal_aborted' }]);
    expect(await h.decisions(entryId)).toEqual([]);
    const error = await h.cmdError({
      name: 'decision.respond',
      entryId,
      decisionId: created[0]?.id ?? sampleId('dc', 9),
      response: { kind: 'permission', response: { behavior: 'allow' } },
    });
    expect(error.code).toBe('DECISION_ALREADY_RESOLVED');
  });

  it('first click wins: the second respond (other client) → DECISION_ALREADY_RESOLVED, byClientId = first', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000b1' });
    const PROMPT = c.ids.uuid();
    const INPUT = { command: 'mkdir build', description: 'Create build' };
    const events = join(
      input(c, PROMPT, 'Make the build dir'),
      turnOpen(c, PROMPT),
      toolUseBlock(c, 'Bash', INPUT, { toolUseId: 'toolu_first_click' }),
      permissionStep(c, { toolName: 'Bash', input: INPUT, toolUseId: 'toolu_first_click', decision: null }),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('first-click', events) });
    const entryId = await h.create('Make the build dir');
    await h.settle();
    const [decision] = await h.decisions(entryId);
    if (decision === undefined) throw new Error('no decision');
    const first = sampleId('cl', 1);
    const second = sampleId('cl', 2);
    const respond = (clientId: typeof first, behavior: 'allow' | 'deny') =>
      h.manager.handleCommand(
        {
          name: 'decision.respond',
          entryId,
          decisionId: decision.id,
          response:
            behavior === 'allow'
              ? { kind: 'permission', response: { behavior: 'allow', remember: null, acceptEdits: false } }
              : { kind: 'permission', response: { behavior: 'deny', message: '', interrupt: false } },
        },
        { clientId, cmdId: randomUUID() },
      );
    const results = await Promise.allSettled([respond(first, 'allow'), respond(second, 'deny')]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { outcome: { type: 'allowed' } } });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { error: { code: 'DECISION_ALREADY_RESOLVED' } },
    });
    const resolved = h.publisher.opsOf(entryId).filter((op) => op.op === 'decision.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ byClientId: first });
  });

  it('priority now cancels open main-agent decisions (interrupted, deny without interrupt)', async () => {
    const h = await setup();
    const entryId = await h.create('fake:bash');
    await h.settle();
    expect((await h.decisions(entryId)).filter((d) => d.state === 'open')).toHaveLength(1);
    await h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'Do something else' },
      priority: 'now',
    });
    await h.settle();
    expect(outcomes(h, entryId)).toEqual([{ type: 'cancelled', reason: 'interrupted' }]);
  });

  it('session.interrupt answers open decisions with deny + interrupt first', async () => {
    const h = await setup();
    const entryId = await h.create('fake:bash');
    await h.settle();
    const result = await h.cmd({ name: 'session.interrupt', entryId });
    expect(result).toEqual({ stillQueued: [] });
    await h.settle();
    expect(outcomes(h, entryId)).toEqual([{ type: 'cancelled', reason: 'interrupted' }]);
    expect(h.facts(entryId).runState).toBe('idle');
    expect(h.facts(entryId).lastTurn?.outcome).toBe('interrupted');
  });
});

// =====================================================================================
// Restart (A.10, R0-17)
// =====================================================================================

describe('restart', () => {
  it('open plan decision: shutdown keeps it → interrupted + needs-resume, expired card; approve resumes', async () => {
    const parsed = await loadFixtureScenario('plan-mode');
    const h1 = await setup({ scenario: () => fixtureScenario(parsed) });
    const entryId = await h1.create(
      'Plan how to create the file hello.txt in the current directory containing the text: hello. Keep the plan very short, then call ExitPlanMode.',
      { permissionMode: 'plan' },
    );
    await h1.drive(entryId, parsed, {
      until: () => h1.facts(entryId).decisions.plan === 1,
    });
    const [open] = await h1.decisions(entryId);
    if (open?.kind !== 'plan') throw new Error('no open plan decision');
    expect(h1.facts(entryId).runState).toBe('working');

    const h2 = await h1.restart({ scenario: undefined });
    harnesses.push(h2);
    expect(h1.stores.decisions.flushes).toBeGreaterThan(0);
    expect(h2.facts(entryId)).toMatchObject({ runState: 'interrupted', decisions: { expired: 1, plan: 0 } });
    expect(h2.status(entryId).kind).toBe('needs-resume');
    const view = await h2.manager.loadView(entryId);
    expect(view?.decisions).toEqual([{ ...open, state: 'expired' }]);
    const tool = view?.items.find(
      (i): i is ToolCallItem => i.kind === 'tool_call' && i.toolUseId === open.toolUseId,
    );
    expect(tool?.status).toBe('interrupted');
    expect(tool?.decision?.outcome).toEqual({ type: 'expired' });

    // Any other answer than "approve" → DECISION_EXPIRED.
    const expired = await h2.cmdError({
      name: 'decision.respond',
      entryId,
      decisionId: open.id,
      response: { kind: 'plan', response: { behavior: 'revise', feedback: 'no' } },
    });
    expect(expired.code).toBe('DECISION_EXPIRED');

    const approved = await h2.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: open.id,
      response: { kind: 'plan', response: { behavior: 'approve', mode: 'acceptEdits' } },
    });
    expect(approved.outcome).toEqual({ type: 'plan_approved', mode: 'acceptEdits', edited: false });
    expect(h2.backend.starts[0]).toMatchObject({
      permissionMode: 'acceptEdits',
      resumeSessionId: '84a2a7ef-261a-478f-83b7-8718d711c257',
    });
    const sent = h2.session(entryId).sent[0];
    const text = sent?.content[0];
    expect(text?.type === 'text' ? text.text : '').toBe(`Implement the plan in ${open.planFilePath ?? ''}`);
    expect(h2.publisher.opsOf(entryId).filter((op) => op.op === 'decision.resolved')).toEqual([
      expect.objectContaining({ decisionId: open.id, outcome: approved.outcome }),
    ]);
    await h2.waitFor(() => h2.facts(entryId).runState === 'idle');
    expect(h2.facts(entryId).decisions.expired).toBe(0);
  });

  it('session.resume closes expired cards (decision.resolved expired)', async () => {
    const decision: Decision = {
      id: sampleId('dc', 5),
      entryId: sampleId('en', 5),
      conversationId: sampleId('cv', 5),
      toolUseId: 'toolu_resume_closes',
      toolName: 'Bash',
      requester: { kind: 'main' },
      createdAt: SAMPLE_TIME,
      state: 'open',
      kind: 'permission',
      input: { command: 'dir' },
      inputTruncated: null,
      title: null,
      displayName: null,
      description: null,
      decisionReason: null,
      decisionReasonType: null,
      blockedPath: null,
      mcpServer: null,
      offer: { rules: [], directories: [], ruleDestinations: [], acceptEdits: false, defaultToNo: false },
    };
    const entry = sampleEntry({
      id: sampleId('en', 5),
      conversations: [sampleConversation({ id: sampleId('cv', 5) })],
      lastRunState: 'working',
    });
    const h = await setup({
      seed: {
        entries: [entry],
        decisions: [
          {
            entryId: entry.id,
            records: [
              {
                id: decision.id,
                kind: 'permission',
                conversationId: decision.conversationId,
                toolUseId: decision.toolUseId,
                toolName: 'Bash',
                requester: { kind: 'main' },
                createdAt: SAMPLE_TIME,
                resolvedAt: null,
                outcome: null,
                planVersion: null,
                planFilePath: null,
                decision,
              },
            ],
          },
        ],
      },
    });
    expect(h.status(entry.id).kind).toBe('needs-resume');
    const permission = await h.cmdError({
      name: 'decision.respond',
      entryId: entry.id,
      decisionId: decision.id,
      response: { kind: 'permission', response: { behavior: 'allow' } },
    });
    expect(permission.code).toBe('DECISION_EXPIRED');
    await h.cmd({ name: 'session.resume', entryId: entry.id });
    expect(outcomes(h, entry.id)).toEqual([{ type: 'expired' }]);
    expect(h.facts(entry.id).decisions.expired).toBe(0);
  });

  it('working → interrupted, idle → sleeping; unread and context from the registry (R0-17)', async () => {
    const working = sampleEntry({
      id: sampleId('en', 11),
      conversations: [sampleConversation({ id: sampleId('cv', 11), lastOrder: 4 })],
      lastRunState: 'working',
      unread: false,
    });
    const idle = sampleEntry({
      id: sampleId('en', 12),
      conversations: [sampleConversation({ id: sampleId('cv', 12) })],
      lastRunState: 'idle',
      unread: true,
      context: sampleContextGauge({ percentage: 42 }),
      contextPct: 42,
    });
    const running = sampleItems.toolCall({
      id: 'msg_x:0',
      order: 4,
      status: 'running',
      toolUseId: 'toolu_running',
    });
    const h = await setup({
      seed: {
        entries: [working, idle],
        transcripts: [{ entryId: working.id, conversationId: sampleId('cv', 11), items: [running] }],
      },
    });
    expect(h.facts(working.id).runState).toBe('interrupted');
    expect(h.facts(idle.id)).toMatchObject({ runState: 'sleeping', unread: true });
    expect(h.summary(idle.id).context?.percentage).toBe(42);
    expect(h.stores.registry.get(working.id)?.lastRunState).toBe('interrupted');
    expect(h.stores.registry.get(idle.id)?.lastRunState).toBe('sleeping');
    const fixed = h.stores.transcripts.items(working.id, sampleId('cv', 11)).find((i) => i.id === 'msg_x:0');
    expect(fixed).toMatchObject({ kind: 'tool_call', status: 'interrupted' });
    expect(h.status(idle.id)).toMatchObject({ kind: 'sleeping', unread: true });
  });

  it('error facts and codes survive the restart', async () => {
    const entry = sampleEntry({
      id: sampleId('en', 13),
      lastRunState: 'error',
      lastError: { ...makeError('SESSION_HELD_ELSEWHERE'), at: SAMPLE_TIME },
    });
    const h = await setup({ seed: { entries: [entry] } });
    expect(h.facts(entry.id)).toMatchObject({ runState: 'error', errorCode: 'SESSION_HELD_ELSEWHERE' });
  });
});

// =====================================================================================
// loadView race (WP-10 Punkt 5), presence, orphans, shutdown
// =====================================================================================

describe('loadView', () => {
  it('ops published while readTail runs are part of the loaded view', async () => {
    const entry = sampleEntry({
      id: sampleId('en', 21),
      conversations: [sampleConversation({ id: sampleId('cv', 21) })],
    });
    const h = await setup({
      seed: {
        entries: [entry],
        transcripts: [
          { entryId: entry.id, conversationId: sampleId('cv', 21), items: [sampleItems.userMessage()] },
        ],
      },
    });
    const transcripts: TranscriptStore = h.stores.transcripts;
    const original = transcripts.readTail.bind(transcripts);
    const gate = Promise.withResolvers<undefined>();
    h.stores.transcripts.readTail = async (...args) => {
      await gate.promise;
      return original(...args);
    };
    const loading = h.manager.loadView(entry.id);
    h.claude.setLaunchError(makeError('CLAUDE_NOT_FOUND'));
    const error = await h.cmdError({ name: 'session.resume', entryId: entry.id });
    expect(error.code).toBe('CLAUDE_NOT_FOUND');
    gate.resolve(undefined);
    const view = await loading;
    expect(view?.items.map((i) => i.kind)).toEqual(['user_message', 'system']);
    const px = view?.items[1];
    expect(px?.kind === 'system' && px.event === 'error' ? px.error.code : null).toBe('CLAUDE_NOT_FOUND');
    expect(px?.order).toBe(6);
  });

  it('unknown entry → null; a running entry answers synchronously from its mirror', async () => {
    const h = await setup();
    expect(await h.manager.loadView(sampleId('en', 99))).toBeNull();
    const entryId = await h.create('hello');
    await h.settle();
    const view = await h.manager.loadView(entryId);
    expect(view?.detail.models?.length).toBeGreaterThan(0);
    expect(view?.items.some((i) => i.kind === 'assistant_text')).toBe(true);
    expect(view?.detail.init).not.toBeNull();
  });
});

describe('presence and notifications', () => {
  it('a visible client viewing the entry → no unread, no notification', async () => {
    const h = await setup({ scenario: () => eventsScenario('turn', textTurnEvents()) });
    const entryId = await h.create(null);
    const watching = viewer(entryId);
    h.publisher.setPresence([watching]);
    h.manager.onPresenceChanged([watching]);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await h.waitFor(() => h.facts(entryId).runState === 'idle' && h.facts(entryId).lastTurn !== null);
    expect(h.facts(entryId).unread).toBe(false);
    expect(h.publisher.notifications).toEqual([]);
  });

  it('done: in_app to the focused window only for long turns; system to the last focused client', async () => {
    const h = await setup({ scenario: () => eventsScenario('turn', textTurnEvents()) });
    const entryId = await h.create(null);
    const away = viewer(null, { focused: false, visible: false });
    h.publisher.setPresence([away]);
    h.manager.onPresenceChanged([away]);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await h.waitFor(() => h.facts(entryId).unread);
    await h.settle();
    expect(
      h.publisher.notifications.map((n) => [n.clientId, n.notification.kind, n.notification.delivery]),
    ).toEqual([[away.clientId, 'done', 'system']]);
    // Seen → viewed + clear.
    const look = viewer(entryId, {}, 3);
    h.manager.onPresenceChanged([look]);
    expect(h.facts(entryId).unread).toBe(false);
    expect(h.publisher.cleared).toContain(entryId);
  });

  it('WP22-03/-15: native toast for a window without Web Notifications and without any window; cleared with the card', async () => {
    const shown: { entryId: string; kind: string; title: string }[] = [];
    const cleared: string[] = [];
    const toasts = {
      available: () => true,
      show: (entryId: string, kind: string, title: string) => shown.push({ entryId, kind, title }),
      clear: (entryId: string) => cleared.push(entryId),
      idle: () => Promise.resolve(),
    };
    const blocked = viewer(null, { focused: false, visible: false, systemNotifications: false });
    const h = await setup({ toasts, presence: [blocked] });
    expect(h.manager.hostState().nativeNotifications).toBe(true);
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    expect(shown).toEqual([{ entryId, kind: 'permission', title: 'fake:bash' }]);
    // The window keeps its in-app hint (it shows it when the user comes back).
    expect(h.publisher.notifications.map((n) => [n.clientId, n.notification.delivery])).toEqual([
      [blocked.clientId, 'in_app'],
    ]);
    const [decision] = await h.decisions(entryId);
    if (decision === undefined) throw new Error('no decision');
    await h.cmd({
      name: 'decision.respond',
      entryId,
      decisionId: decision.id,
      response: { kind: 'permission', response: { behavior: 'allow', remember: null, acceptEdits: false } },
    });
    await h.settle();
    expect(cleared).toContain(entryId);
    // No window at all: a native toast only.
    h.publisher.setPresence([]);
    h.manager.onPresenceChanged([]);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'fake:bash again' } });
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.settle();
    // permission, done of the allowed turn (the window still cannot show it), permission again.
    expect(shown.map((s) => s.kind)).toEqual(['permission', 'done', 'permission']);
    expect(h.publisher.notifications.map((n) => n.notification.kind)).toEqual(['permission', 'done']);
  });
});

describe('engine extras', () => {
  it('AI title after the first turn (getSessionInfo), git branch at the end of the turn', async () => {
    const h = await setup({
      gitBranch: (cwd) => Promise.resolve(cwd === 'D:\\work\\parallax-harness' ? 'main' : null),
    });
    const entryId = await h.create('Tell me about parsers please');
    expect(h.summary(entryId).titleSource).toBe('prompt');
    await h.waitFor(() => h.summary(entryId).titleSource === 'ai');
    expect(h.summary(entryId).title).toMatch(/^Fake: /);
    await h.waitFor(() => h.summary(entryId).gitBranch === 'main');
    expect(h.manager.inspect(entryId)?.gitBranch).toBe('main');
  });

  it('rejected project MCP servers → host warning; rate limits → accountLimits (host state debounced 1 s)', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000e1' });
    const prompt = c.ids.uuid();
    const events = join(
      input(c, prompt, 'hi'),
      turnOpen(c, prompt),
      toEvents([
        frame(
          c,
          init(0, {
            mcp_servers: [{ name: 'proj-db', status: 'needs-approval', source: 'projectSettings' }],
          }),
        ),
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
    const h = await setup({ scenario: () => eventsScenario('mcp-rate', events) });
    const entryId = await h.create('hi');
    await h.settle();
    const warning = h.manager.hostState().warnings.find((w) => w.id === `mcp:${entryId}`);
    expect(warning?.error).toEqual({ code: 'MCP_SERVER_NOT_APPROVED', params: { servers: 'proj-db' } });
    expect(h.publisher.hostStates.at(-1)?.warnings.map((w) => w.id)).toContain(`mcp:${entryId}`);
    expect(h.manager.hostState().accountLimits.standard?.status).toBe('allowed_warning');
    const published = h.publisher.hostStates.length;
    expect(h.timers.pending().map((t) => t.ms)).toContain(1_000);
    h.timers.advance(1_000);
    expect(h.publisher.hostStates).toHaveLength(published + 1);
    expect(h.publisher.hostStates.at(-1)?.accountLimits.standard?.utilization).toBe(0.85);
  });

  it('sleep policy (Phase-2 hook): idle + canSleep → close (sleep) → sleeping, unread kept', async () => {
    const h = await setup({
      scenario: () => eventsScenario('turn', textTurnEvents()),
      sleepPolicy: { schedule: () => 60_000 },
    });
    const entryId = await h.create('Reply with exactly: OK');
    await h.waitFor(() => h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(h.timers.pending().map((t) => t.ms)).toEqual([60_000]);
    h.timers.advance(60_000);
    await h.waitFor(() => h.facts(entryId).runState === 'sleeping');
    expect(h.facts(entryId).unread).toBe(true);
    expect(h.session(entryId).state).toBe('exited');
  });

  it('hostState is schema-true and lists every profile; setupRequired from the default profile', async () => {
    const h = await setup();
    const host = h.manager.hostState();
    expect(host).toMatchObject({
      backend: 'fake',
      defaultProfileId: 'standard',
      setupRequired: false,
      dev: true,
    });
    expect(host.profiles.map((p) => p.id)).toEqual(['standard']);
    h.manager.publishHostState();
    expect(h.publisher.hostStates.at(-1)).toEqual(host);
  });
});

function textTurnEvents(): FixtureEvent[] {
  const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000c1' });
  const prompt = c.ids.uuid();
  return join(input(c, prompt, 'Reply with exactly: OK'), textTurn(c, { prompt, text: 'OK' }), closeGate());
}

/** One turn whose result reports `total` as total_cost_usd (the CLI's counter of this process). */
function costTurnEvents(total: number): FixtureEvent[] {
  const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000c2' });
  const prompt = c.ids.uuid();
  return join(
    input(c, prompt, 'Reply with exactly: OK'),
    turnOpen(c, prompt),
    turnClose(c, prompt, { result: { result: 'OK', total_cost_usd: total } }),
    closeGate(),
  );
}

describe('permission mode set by the CLI (WP22-04)', () => {
  it('a mode change inside a turn (status message) reaches the summary – header and composer show it', async () => {
    const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000c3' });
    const prompt = c.ids.uuid();
    const events = join(
      input(c, prompt, 'Reply with exactly: OK'),
      turnOpen(c, prompt),
      toEvents([frame(c, system(0, 'status', { status: null, permissionMode: 'auto' }))]),
      turnClose(c, prompt, { result: { result: 'OK' } }),
      closeGate(),
    );
    const h = await setup({ scenario: () => eventsScenario('auto-switch', events) });
    const entryId = await h.create('Reply with exactly: OK');
    await h.waitFor(() => h.summary(entryId).permissionMode === 'auto');
    expect(h.stores.registry.get(entryId)?.permissionMode).toBe('auto');
    expect(
      h.publisher.summaries.some((s) => s.summary.entryId === entryId && s.summary.permissionMode === 'auto'),
    ).toBe(true);
  });
});

describe('costs (WP22-10)', () => {
  it('the conversation cost sums the query segments: a resumed CLI starts total_cost_usd at 0', async () => {
    const h = await setup({
      scenario: scenarios(
        eventsScenario('first', costTurnEvents(0.003)),
        eventsScenario('resumed', costTurnEvents(0.0005)),
      ),
    });
    const entryId = await h.create('Reply with exactly: OK');
    await h.waitFor(() => h.facts(entryId).runState === 'idle' && h.facts(entryId).lastTurn !== null);
    const cost = () => currentConversation(h.stores.registry.get(entryId) ?? sampleEntry()).costUsd;
    expect(cost()).toBe(0.003);
    await h.cmd({ name: 'session.close', entryId });
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: OK' } });
    await h.waitFor(() => h.backend.starts.length === 2 && h.facts(entryId).runState === 'idle');
    await h.settle();
    expect(cost()).toBe(0.0035);
  });
});

describe('orphans', () => {
  const record = (n: number) => ({
    entryId: sampleId('en', 40 + n),
    pid: 50_000 + n,
    image: 'claude.exe',
    startedAt: SAMPLE_TIME,
  });

  const entry41 = sampleEntry({
    id: sampleId('en', 41),
    conversations: [sampleConversation({ id: sampleId('cv', 41) })],
  });
  const at = (s: number) => new Date(Date.parse(SAMPLE_TIME) + s * 1000);
  const alive = (...pids: number[]) => {
    const set = new Set(pids);
    return (pid: number) => set.has(pid);
  };

  it('one bundled query: name + start match → taskkill, mismatch/reused → untouched; the start waits visibly', async () => {
    const gate = Promise.withResolvers<undefined>();
    const h = await setup({
      seed: { entries: [entry41] },
      processes: [record(1), record(2), record(3), record(4)],
      proc: {
        isProcessAlive: alive(50_001, 50_002, 50_003, 50_004),
        queryProcesses: async () => {
          await gate.promise;
          return {
            kind: 'ok',
            processes: [
              { pid: 50_001, name: 'CLAUDE.EXE', parentPid: 1, startedAt: at(4) },
              { pid: 50_002, name: 'notepad.exe', parentPid: 1, startedAt: at(0) },
              { pid: 50_003, name: 'claude.exe', parentPid: 1, startedAt: at(60) },
              // 50_004 ended in between → gone
            ],
          };
        },
      },
    });
    // The start of entry 41 waits for its orphan check – visibly (R2-02).
    const resume = h.cmd({ name: 'session.resume', entryId: entry41.id });
    await h.settle();
    expect(h.backend.starts).toHaveLength(0);
    expect(h.facts(entry41.id).runState).toBe('starting');
    expect(h.proc.queries).toEqual([{ pids: [50_001, 50_002, 50_003, 50_004] }]);
    gate.resolve(undefined);
    await resume;
    await h.manager.orphansDone();
    await h.settle();
    expect(h.backend.starts).toHaveLength(1);
    expect(h.proc.killed).toEqual([50_001]);
    expect(h.stores.processes.records().map((r) => r.pid)).toEqual([h.session(entry41.id).pid]);
  });

  it('dead PIDs need no PowerShell: removed at once, the start does not wait (pre-filter)', async () => {
    const never = Promise.withResolvers<undefined>();
    const h = await setup({
      seed: { entries: [entry41] },
      processes: [record(1), record(2)],
      proc: {
        isProcessAlive: () => false,
        queryProcesses: async () => {
          await never.promise;
          return { kind: 'ok', processes: [] };
        },
      },
    });
    await h.manager.orphansDone();
    expect(h.proc.queries).toEqual([]);
    expect(h.stores.processes.records()).toEqual([]);
    await h.cmd({ name: 'session.resume', entryId: entry41.id });
    expect(h.backend.starts).toHaveLength(1);
  });

  it('an inconclusive query (timeout) kills nothing and keeps the record for the next start', async () => {
    const h = await setup({
      seed: { entries: [entry41] },
      processes: [record(1)],
      proc: {
        isProcessAlive: alive(50_001),
        queryProcesses: () =>
          Promise.resolve({ kind: 'unknown', reason: 'timeout', detail: 'no answer within 60000 ms' }),
      },
    });
    await h.manager.orphansDone();
    expect(h.proc.killed).toEqual([]);
    expect(h.stores.processes.records().map((r) => r.pid)).toEqual([50_001]);
    // The start goes on after the check (the record stays until the next server start).
    await h.cmd({ name: 'session.resume', entryId: entry41.id });
    await h.settle();
    expect(h.backend.starts).toHaveLength(1);
    expect(h.stores.processes.records().map((r) => r.pid)).toEqual([50_001, h.session(entry41.id).pid]);
  });

  it('children the last snapshot did not see are neither searched nor ended (R2-03)', async () => {
    const h = await setup({ processes: [{ ...record(5), startedAt: at(-60).toISOString() }] });
    h.proc.info.set(60_001, { pid: 60_001, name: 'node.exe', parentPid: 50_005, startedAt: at(-30) });
    await h.manager.orphansDone();
    expect(h.proc.queries).toEqual([]);
    expect(h.proc.killed).toEqual([]);
    expect(h.stores.processes.records()).toEqual([]);
  });

  it('WP22-06 heartbeat: snapshot of the tree below every claude.exe, then every interval; stops with the last process', async () => {
    const h = await setup({
      scenario: () => eventsScenario('turn', textTurnEvents()),
      options: { processSnapshotMs: 30_000, processSnapshotFirstMs: 10_000 },
    });
    const entryId = await h.create('Reply with exactly: OK');
    await h.settle();
    const pid = h.session(entryId).pid;
    const spawned = h.now();
    const t = (s: number) => new Date(spawned.getTime() + s * 1000);
    h.proc.info.set(pid, { pid, name: 'claude.exe', parentPid: process.pid, startedAt: t(0) });
    h.proc.info.set(70_001, { pid: 70_001, name: 'cmd.exe', parentPid: pid, startedAt: t(1) });
    h.proc.info.set(70_002, { pid: 70_002, name: 'powershell.exe', parentPid: 70_001, startedAt: t(2) });
    h.proc.info.set(70_003, { pid: 70_003, name: 'PING.EXE', parentPid: 70_002, startedAt: t(3) });
    // An older process whose ParentProcessId is the (reused) PID: never part of the tree.
    h.proc.info.set(70_004, { pid: 70_004, name: 'old.exe', parentPid: pid, startedAt: t(-100) });
    expect(h.timers.pending().map((x) => x.ms)).toEqual([10_000]);
    h.timers.advance(10_000);
    await h.settle();
    const [snap] = h.stores.processes.records();
    expect(snap?.aliveAt).toBe(h.now().toISOString());
    expect(snap?.children).toEqual([
      { pid: 70_001, image: 'cmd.exe', startedAt: t(1).toISOString() },
      { pid: 70_002, image: 'powershell.exe', startedAt: t(2).toISOString() },
      { pid: 70_003, image: 'PING.EXE', startedAt: t(3).toISOString() },
    ]);
    expect(h.timers.pending().map((x) => x.ms)).toEqual([30_000]);
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();
    expect(h.timers.pending()).toEqual([]);
    expect(h.stores.processes.records()).toEqual([]);
  });

  it('WP22-06 heartbeat: a PID that is not the spawned claude.exe (fake/reused) lends no tree', async () => {
    const h = await setup({
      scenario: () => eventsScenario('turn', textTurnEvents()),
      options: { processSnapshotMs: 30_000, processSnapshotFirstMs: 10_000 },
    });
    const entryId = await h.create('Reply with exactly: OK');
    await h.settle();
    const pid = h.session(entryId).pid;
    const t = (s: number) => new Date(h.now().getTime() + s * 1000);
    // Same PID, but another program (or started long before the spawn).
    h.proc.info.set(pid, { pid, name: 'notepad.exe', parentPid: 1, startedAt: t(0) });
    h.proc.info.set(70_101, { pid: 70_101, name: 'child.exe', parentPid: pid, startedAt: t(1) });
    h.timers.advance(10_000);
    await h.settle();
    expect(h.stores.processes.records()[0]).toMatchObject({ aliveAt: null, children: [] });
    h.proc.info.set(pid, { pid, name: 'claude.exe', parentPid: 1, startedAt: t(-3_600) });
    h.timers.advance(30_000);
    await h.settle();
    expect(h.stores.processes.records()[0]).toMatchObject({ aliveAt: null, children: [] });
    await h.cmd({ name: 'session.close', entryId });
  });

  it('WP22-06 restart: processes of the snapshot that still run exactly as recorded are ended, the root is gone', async () => {
    const shell = { pid: 70_011, image: 'powershell.exe', startedAt: at(5).toISOString() };
    const ping = { pid: 70_012, image: 'PING.EXE', startedAt: at(6).toISOString() };
    const h = await setup({
      seed: { entries: [entry41] },
      processes: [{ ...record(1), aliveAt: at(30).toISOString(), children: [shell, ping] }],
      proc: { isProcessAlive: alive(70_011, 70_012) },
      start: false,
    });
    h.proc.info.set(70_011, { pid: 70_011, name: 'powershell.exe', parentPid: 70_010, startedAt: at(5) });
    // PID 70_012 now belongs to another program (other start time): untouched.
    h.proc.info.set(70_012, { pid: 70_012, name: 'PING.EXE', parentPid: 1, startedAt: at(500) });
    await h.manager.start();
    await h.manager.orphansDone();
    // CR-01: after the kill of the shell, ping is looked up again right before its own kill.
    expect(h.proc.queries).toEqual([{ pids: [70_011, 70_012] }, { pids: [70_012] }]);
    expect(h.proc.killed).toEqual([70_011]);
    expect(h.stores.processes.records()).toEqual([]);
  });

  it('the shutdown waits at most orphanShutdownWaitMs; a later result is ignored, never thrown (R3-06)', async () => {
    const gate = Promise.withResolvers<undefined>();
    const h = await setup({
      seed: { entries: [entry41] },
      processes: [record(1)],
      proc: {
        isProcessAlive: alive(50_001),
        queryProcesses: async () => {
          await gate.promise;
          return {
            kind: 'ok',
            processes: [{ pid: 50_001, name: 'claude.exe', parentPid: 1, startedAt: at(1) }],
          };
        },
      },
    });
    let closed = false;
    const closing = h.close().then(() => {
      closed = true;
    });
    await h.settle();
    expect(closed).toBe(false);
    h.timers.advance(2_000);
    await closing;
    // The CIM answer comes after the stores were flushed (they close next): ignored, record kept.
    gate.resolve(undefined);
    await h.manager.orphansDone();
    expect(h.proc.killed).toEqual([50_001]);
    expect(h.stores.processes.records().map((r) => r.pid)).toEqual([50_001]);
  });

  it('a dormant rename waits for the orphan check of its entry (R2-08)', async () => {
    const gate = Promise.withResolvers<undefined>();
    const sessionId = '5e550000-0000-4000-8000-0000000000d1';
    const entry = sampleEntry({
      id: sampleId('en', 41),
      conversations: [sampleConversation({ id: sampleId('cv', 41), sessionId })],
    });
    const h = await setup({
      seed: { entries: [entry] },
      processes: [record(1)],
      proc: {
        isProcessAlive: alive(50_001),
        queryProcesses: async () => {
          await gate.promise;
          return { kind: 'ok', processes: [] };
        },
      },
    });
    const renamed = h.cmd({ name: 'session.rename', entryId: entry.id, title: 'New title' });
    await h.settle();
    expect(h.backend.history.info(sessionId)).toBeNull();
    gate.resolve(undefined);
    await renamed;
    expect(h.backend.history.info(sessionId)).toMatchObject({ customTitle: 'New title' });
  });
});

describe('readiness (R2-04)', () => {
  const sessionId = '5e550000-0000-4000-8000-0000000000e1';
  const dormant = sampleEntry({
    id: sampleId('en', 51),
    lastRunState: 'sleeping',
    conversations: [sampleConversation({ id: sampleId('cv', 51), sessionId })],
  });
  const timeout = (): Error =>
    Object.assign(new Error('supportedModels timed out after 60000 ms'), { name: 'TimeoutError' });

  /** supportedModels() of every started session answers through a deferred the test controls. */
  function controlReadiness(h: EngineHarness): PromiseWithResolvers<unknown[]>[] {
    const calls: PromiseWithResolvers<unknown[]>[] = [];
    const start = h.backend.start.bind(h.backend);
    h.backend.start = (req) => {
      const session = start(req);
      session.supportedModels = () => {
        const call = Promise.withResolvers<unknown[]>();
        calls.push(call);
        return call.promise;
      };
      return session;
    };
    return calls;
  }

  it('fails twice without a prompt → the process is closed, error CLAUDE_CONTROL_FAILED, no retry', async () => {
    const h = await setup({ seed: { entries: [dormant] } });
    const calls = controlReadiness(h);
    await h.cmd({ name: 'session.resume', entryId: dormant.id });
    await h.settle();
    expect(h.facts(dormant.id).runState).toBe('starting');
    calls[0]?.reject(timeout());
    await h.settle();
    expect(calls).toHaveLength(2);
    expect(h.facts(dormant.id).runState).toBe('starting');
    calls[1]?.reject(timeout());
    await h.waitFor(() => h.facts(dormant.id).runState === 'error');
    await h.settle();
    expect(h.facts(dormant.id).errorCode).toBe('CLAUDE_CONTROL_FAILED');
    expect(h.summary(dormant.id).lastError).toMatchObject({
      code: 'CLAUDE_CONTROL_FAILED',
      params: { method: 'supportedModels' },
    });
    expect(errorItems(h, dormant.id).map((i) => i.error.code)).toEqual(['CLAUDE_CONTROL_FAILED']);
    expect(h.session(dormant.id).state).toBe('exited');
    expect(h.manager.inspect(dormant.id)).toMatchObject({ phase: 'dormant', retryScheduled: false });
  });

  it('a second attempt that answers → idle with models', async () => {
    const h = await setup({ seed: { entries: [dormant] } });
    const calls = controlReadiness(h);
    await h.cmd({ name: 'session.resume', entryId: dormant.id });
    await h.settle();
    calls[0]?.reject(timeout());
    await h.settle();
    calls[1]?.resolve([...FAKE_MODELS]);
    await h.waitFor(() => h.facts(dormant.id).runState === 'idle');
    expect(h.session(dormant.id).state).not.toBe('exited');
    expect((await h.manager.loadView(dormant.id))?.detail.models?.length).toBeGreaterThan(0);
  });

  it('after a prompt the turn decides the status – a failed readiness only logs', async () => {
    const h = await setup({ seed: { entries: [dormant] } });
    const calls = controlReadiness(h);
    await h.cmd({ name: 'session.resume', entryId: dormant.id });
    await h.cmd({
      name: 'session.sendPrompt',
      entryId: dormant.id,
      prompt: { text: 'Reply with exactly: OK' },
    });
    await h.waitFor(() => h.facts(dormant.id).runState === 'idle');
    calls[0]?.reject(timeout());
    await h.settle();
    calls[1]?.reject(timeout());
    await h.settle();
    expect(h.facts(dormant.id).runState).toBe('idle');
    expect(h.session(dormant.id).state).not.toBe('exited');
  });
});

describe('start and stop edges', () => {
  it('a spawn failure without a process fails the command with CLAUDE_SPAWN_FAILED (R2-07)', async () => {
    const h = await setup();
    const entryId = await h.create(null);
    h.backend.start = (req) => {
      const events = new AsyncQueue<BackendEvent>();
      const at = h.now();
      events.push({
        type: 'error',
        where: 'spawn',
        name: 'Error',
        message: 'spawn C:\\fake\\claude.exe ENOENT',
        at,
      });
      events.push({ type: 'exit', code: null, signal: null, expected: false, at });
      events.end();
      const closed = (): Promise<never> => Promise.reject(new Error('session closed'));
      return {
        entryId: req.entryId,
        pid: null,
        events,
        send: () => {
          throw new Error('session closed');
        },
        interrupt: closed,
        setModel: closed,
        setPermissionMode: closed,
        applyFlagSettings: closed,
        getContextUsage: closed,
        supportedModels: closed,
        supportedCommands: closed,
        stopTask: closed,
        close: () => Promise.resolve(),
      };
    };
    const error = await h.cmdError({ name: 'session.sendPrompt', entryId, prompt: { text: 'hi' } });
    expect(error).toMatchObject({ code: 'CLAUDE_SPAWN_FAILED' });
    expect(String(error.params.reason)).toContain('ENOENT');
    expect(h.facts(entryId)).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_SPAWN_FAILED' });
    expect(h.manager.inspect(entryId)).toMatchObject({ phase: 'dormant', retryScheduled: false });
  });

  it('Stop while the start still runs reaches the session after the start (R2-15)', async () => {
    const entry = sampleEntry({
      id: sampleId('en', 41),
      conversations: [sampleConversation({ id: sampleId('cv', 41) })],
    });
    const gate = Promise.withResolvers<undefined>();
    const h = await setup({
      seed: { entries: [entry] },
      processes: [{ entryId: entry.id, pid: 50_001, image: 'claude.exe', startedAt: SAMPLE_TIME }],
      proc: {
        isProcessAlive: (pid) => pid === 50_001,
        queryProcesses: async () => {
          await gate.promise;
          return { kind: 'ok', processes: [] };
        },
      },
    });
    const sent = h.cmd({ name: 'session.sendPrompt', entryId: entry.id, prompt: { text: 'fake:slow' } });
    const stopped = h.cmd({ name: 'session.interrupt', entryId: entry.id });
    await h.settle();
    expect(h.backend.starts).toHaveLength(0);
    gate.resolve(undefined);
    await sent;
    await stopped;
    expect(h.session(entry.id).controls.map((c) => c.method)).toContain('interrupt');
  });

  it('closing with an open decision cancels it as process_exit before close() (R2-16)', async () => {
    const h = await setup();
    const start = h.backend.start.bind(h.backend);
    h.backend.start = (req) => {
      const session = start(req);
      const handle = h.backend.sessions.at(-1);
      const close = session.close.bind(session);
      // Like the real SDK might: the CLI aborts its canUseTool signals while closing.
      session.close = () => {
        handle?.abortDecision();
        return close();
      };
      return session;
    };
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    await h.cmd({ name: 'session.close', entryId });
    await h.settle();
    expect(outcomes(h, entryId)).toEqual([{ type: 'cancelled', reason: 'process_exit' }]);
  });
});

describe('shutdown', () => {
  it('server.shutdown: sessionsStopped counted first, onShutdownRequested after the ack; shutdown keeps facts', async () => {
    const h = await setup({ scenario: () => eventsScenario('turn', textTurnEvents()) });
    const a = await h.create('Reply with exactly: OK');
    await h.create(null);
    await h.settle();
    expect(h.facts(a).runState).toBe('idle');
    const result = await h.cmd({ name: 'server.shutdown' });
    expect(result).toEqual({ sessionsStopped: 1 });
    const error = await h.cmdError({ name: 'session.resume', entryId: a });
    expect(error.code).toBe('SERVER_SHUTTING_DOWN');
    await h.manager.shutdown();
    expect(h.facts(a).runState).toBe('idle');
    expect(h.stores.registry.get(a)?.lastRunState).toBe('idle');
    expect(h.session(a).state).toBe('exited');
    expect(h.stores.processes.records()).toEqual([]);
    expect(h.stores.registry.flushes).toBeGreaterThan(0);
    expect(h.stores.transcripts.flushes).toBeGreaterThan(0);
    expect(h.stores.decisions.flushes).toBeGreaterThan(0);
    expect(h.stores.processes.flushes).toBeGreaterThan(0);
  });

  it('onShutdownRequested runs after the command resolved (setImmediate)', async () => {
    const order: string[] = [];
    const h = await setup({ onShutdownRequested: () => order.push('hook') });
    await h.manager.handleCommand(
      { name: 'server.shutdown' },
      { clientId: HARNESS_CLIENT_ID, cmdId: randomUUID() },
    );
    order.push('ack');
    await h.settle();
    expect(order).toEqual(['ack', 'hook']);
  });

  it('WP22-05: a session waiting for a decision is interrupted before close(); no notification at shutdown', async () => {
    const h = await setup({ presence: [viewer(null, { focused: false, visible: false })] });
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    const notified = h.publisher.notifications.length;
    await h.manager.shutdown();
    const session = h.sessions(entryId)[0];
    expect(session?.controls.map((c) => c.method)).toContain('interrupt');
    expect(session?.state).toBe('exited');
    // The frozen broker keeps the record open (→ expired after the restart, A.10) …
    const h2 = await h.restart({ scenario: undefined });
    harnesses.push(h2);
    expect(h2.facts(entryId)).toMatchObject({ runState: 'interrupted', decisions: { expired: 1 } });
    expect(h2.status(entryId).kind).toBe('needs-resume');
    // … and the turn ended by the interrupt sends no "done" notification.
    expect(h.publisher.notifications.length).toBe(notified);
  });

  /** Every session started from now on reaches its real close() only after `before()` settled. */
  function delayCloses(h: EngineHarness, before: () => Promise<unknown>): void {
    const start = h.backend.start.bind(h.backend);
    h.backend.start = (req) => {
      const session = start(req);
      const close = session.close.bind(session);
      session.close = async () => {
        await before();
        return close();
      };
      return session;
    };
  }

  /**
   * A harness whose taskkill ends the fake process (it exits like a killed claude.exe) and that
   * counts close() calls on sessions that still run (CR-06: a waiting session with queued work
   * must get neither an interrupt nor a close()).
   */
  async function killableSetup(): Promise<{ h: EngineHarness; closes: () => number }> {
    const holder: { h: EngineHarness | null } = { h: null };
    const h = await setup({
      proc: {
        killProcessTree: (pid) => {
          holder.h?.proc.killed.push(pid);
          holder.h?.backend.sessions.find((s) => s.pid === pid && s.state !== 'exited')?.crash(1);
          return Promise.resolve();
        },
      },
    });
    holder.h = h;
    let closes = 0;
    const start = h.backend.start.bind(h.backend);
    h.backend.start = (req) => {
      const session = start(req);
      const handle = h.backend.sessions.at(-1);
      const close = session.close.bind(session);
      session.close = () => {
        if (handle?.state !== 'exited') closes += 1;
        return close();
      };
      return session;
    };
    return { h, closes: () => closes };
  }

  it('CR-06: waiting for a decision with a queued prompt → no interrupt, no close(): its tree ends at once', async () => {
    const { h, closes } = await killableSetup();
    const entryId = await h.create('fake:bash');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 1);
    const { messageUuid } = await h.cmd({
      name: 'session.sendPrompt',
      entryId,
      prompt: { text: 'Reply with exactly: QUEUED' },
    });
    await h.waitFor(() => h.manager.inspect(entryId)?.queue.length === 1);
    const session = h.session(entryId);
    const sessionId = session.sessionId;
    const done = h.manager.shutdown();
    await h.settle();
    await done;
    // No timer was needed: the tree was ended right away, without interrupt or close() (both would
    // start the queued prompt – live: close() lets a waiting CLI fail the permission and go on).
    expect(session.controls.map((c) => c.method)).not.toContain('interrupt');
    expect(closes()).toBe(0);
    expect(h.proc.killed).toEqual([session.pid]);
    expect(session.state).toBe('exited');
    const started = h.backend.history
      .messages(sessionId ?? '')
      .filter((m) => typeof m === 'object' && m !== null && 'uuid' in m && m.uuid === messageUuid);
    expect(started).toEqual([]);
    // The prompt is reported as not delivered (px item, like after a crash).
    expect(errorItems(h, entryId).map((i) => i.error.code)).toEqual(['PROMPT_NOT_DELIVERED']);
    // The record of the open decision stays open (→ expired after the restart, A.10).
    const h2 = await h.restart({ scenario: undefined });
    harnesses.push(h2);
    expect(h2.facts(entryId).decisions.expired).toBe(1);
  });

  it('CR-06: waiting for a decision while background work runs → no interrupt, no close() (a task would start a turn)', async () => {
    const { h, closes } = await killableSetup();
    const entryId = await h.create('fake:parallel');
    await h.waitFor(() => h.facts(entryId).decisions.permission === 2);
    expect(h.facts(entryId).backgroundTasks).toBeGreaterThan(0);
    const session = h.session(entryId);
    await h.manager.shutdown();
    expect(session.controls.map((c) => c.method)).not.toContain('interrupt');
    expect(closes()).toBe(0);
    expect(h.proc.killed).toEqual([session.pid]);
    expect(session.state).toBe('exited');
  });

  it('CR-02: a close() that needs 4 s (SessionEnd hooks, transcript) is not cut off', async () => {
    const h = await setup({ scenario: () => eventsScenario('turn', textTurnEvents()) });
    const release = Promise.withResolvers<undefined>();
    delayCloses(h, () => release.promise);
    const entryId = await h.create('Reply with exactly: OK');
    await h.settle();
    const session = h.session(entryId);
    const done = h.manager.shutdown();
    await h.settle();
    h.timers.advance(4_000);
    await h.settle();
    release.resolve(undefined);
    await done;
    expect(h.proc.killed).toEqual([]);
    expect(session.state).toBe('exited');
  });

  it('a process that ignores close() is killed after shutdownKillAfterMs (WP22-05)', async () => {
    const killed: number[] = [];
    const pendingCloses: (() => void)[] = [];
    const holder: { h: EngineHarness | null } = { h: null };
    const h = await setup({
      scenario: () => eventsScenario('turn', textTurnEvents()),
      proc: {
        killProcessTree: (pid) => {
          killed.push(pid);
          // taskkill ends the hanging process: it exits now, the hanging close() returns.
          const session = holder.h?.backend.sessions.find((s) => s.pid === pid);
          if (session !== undefined) {
            Reflect.deleteProperty(session, 'close');
            session.crash(1);
          }
          for (const release of pendingCloses.splice(0)) release();
          return Promise.resolve();
        },
      },
    });
    holder.h = h;
    const entryId = await h.create('Reply with exactly: OK');
    await h.settle();
    const session = h.session(entryId);
    Object.defineProperty(session, 'close', {
      configurable: true,
      value: () =>
        new Promise<void>((resolve) => {
          pendingCloses.push(resolve);
        }),
    });
    const done = h.manager.shutdown();
    await h.settle();
    // C.8 (CR-02): 5 s after close(), then taskkill; 15 s bound the whole step.
    expect(h.timers.pending().map((t) => t.ms)).toEqual([5_000, 15_000]);
    h.timers.advance(4_999);
    await h.settle();
    expect(killed).toEqual([]);
    h.timers.advance(1);
    await done;
    expect(killed).toEqual([session.pid]);
    // Shutdown: nothing persisted from the forced exit (the last state stays).
    expect(h.facts(entryId).runState).toBe('idle');
  });
});
