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
import { init, msg } from './normalizer/synthetic/build';
import { FAKE_SCENARIOS } from '../backend/fake/synthetic';
import { loadFixtureScenario } from '../backend/fake/testing';
import type { FixtureEvent } from '../backend/fixture';
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

describe('orphans', () => {
  const record = (n: number) => ({
    entryId: sampleId('en', 40 + n),
    pid: 50_000 + n,
    image: 'claude.exe',
    startedAt: SAMPLE_TIME,
  });

  it('name + start time match → taskkill; mismatch or gone → untouched; records removed; start waits', async () => {
    const entry = sampleEntry({
      id: sampleId('en', 41),
      conversations: [sampleConversation({ id: sampleId('cv', 41) })],
    });
    const gate = Promise.withResolvers<undefined>();
    const h = await setup({
      seed: { entries: [entry] },
      processes: [record(1), record(2), record(3), record(4)],
      proc: {
        processInfo: async (pid) => {
          await gate.promise;
          if (pid === 50_001)
            return {
              pid,
              name: 'CLAUDE.EXE',
              parentPid: 1,
              startedAt: new Date(Date.parse(SAMPLE_TIME) + 4_000),
            };
          if (pid === 50_002)
            return { pid, name: 'notepad.exe', parentPid: 1, startedAt: new Date(SAMPLE_TIME) };
          if (pid === 50_003)
            return {
              pid,
              name: 'claude.exe',
              parentPid: 1,
              startedAt: new Date(Date.parse(SAMPLE_TIME) + 60_000),
            };
          return null;
        },
      },
    });
    // The start of entry 41 waits for its orphan cleanup.
    const resume = h.cmd({ name: 'session.resume', entryId: entry.id });
    await h.settle();
    expect(h.backend.starts).toHaveLength(0);
    gate.resolve(undefined);
    await resume;
    await h.manager.orphansDone();
    await h.settle();
    expect(h.backend.starts).toHaveLength(1);
    expect(h.proc.killed).toEqual([50_001]);
    expect(h.stores.processes.records().map((r) => r.pid)).toEqual([h.session(entry.id).pid]);
  });

  it('children of a dead claude.exe that started after it (and before this server) are ended', async () => {
    const at = (s: number) => new Date(Date.parse(SAMPLE_TIME) + s * 1000);
    const h = await setup({
      processes: [{ ...record(5), startedAt: at(-60).toISOString() }],
      proc: {
        processInfo: () => Promise.resolve(null),
        childProcesses: (pid) =>
          Promise.resolve(
            pid === 50_005
              ? [
                  { pid: 60_001, name: 'node.exe', parentPid: pid, startedAt: at(-30) },
                  { pid: 60_002, name: 'old.exe', parentPid: pid, startedAt: at(-120) },
                ]
              : [],
          ),
      },
    });
    await h.manager.orphansDone();
    expect(h.proc.killed).toEqual([60_001]);
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

  it('a process that ignores close() is killed after shutdownTimeoutMs', async () => {
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
    expect(h.timers.pending().map((t) => t.ms)).toEqual([15_000]);
    h.timers.advance(15_000);
    await done;
    expect(killed).toEqual([session.pid]);
    // Shutdown: nothing persisted from the forced exit (the last state stays).
    expect(h.facts(entryId).runState).toBe('idle');
  });
});
