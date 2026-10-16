/**
 * WP-13 §5.2 – the recorded fixtures through the whole engine: SessionManager + FakeBackend +
 * memory stores/publisher (hub-like validation of every op/summary) + the real WP-12 modules.
 * Decisions are answered with `answerFromFixture`; the FakeBackend compares the PermissionResult the
 * broker built with the recorded one (diagnostics). Known, intended mismatches (ADR-012: rules AND
 * directories go to the same destination, setMode always `session`) are listed explicitly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentConversation, type TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
import { sampleConversation, sampleEntry, sampleId } from '@shared/samples';
import { deriveDisplayStatus } from '@shared/status';
import { createFakeHistoryStore, fixtureScenario } from '../backend/fakeBackend';
import { loadFixtureScenario } from '../backend/fake/testing';
import type { ParsedFixture } from '../backend/fixture';
import { HARNESS_CLIENT_ID, createEngineHarness, type EngineHarness } from './testing/harness';

// Whole-engine runs: generous per-test bound for parallel load (the logic itself uses no wall clock).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let harness: EngineHarness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    expect(harness.errors).toEqual([]);
  }
  harness = null;
});

async function setup(name: string, extra: Parameters<typeof createEngineHarness>[0] = {}) {
  const parsed = await loadFixtureScenario(name);
  const h = await createEngineHarness({ scenario: () => fixtureScenario(parsed), ...extra });
  harness = h;
  return { h, parsed };
}

function firstPrompt(parsed: ParsedFixture): string {
  const input = parsed.events.find((e) => e.kind === 'input');
  const payload = input?.payload;
  if (typeof payload !== 'object' || payload === null || !('message' in payload)) throw new Error('no input');
  const message: unknown = payload.message;
  if (
    typeof message === 'object' &&
    message !== null &&
    'content' in message &&
    typeof message.content === 'string'
  )
    return message.content;
  throw new Error('input without text');
}

/** Diagnostics except the known decision mismatches (seq numbers of the fixture). */
function unexpectedDiagnostics(h: EngineHarness, entryId: string, knownDecisionSeqs: number[] = []) {
  return h
    .sessions(entryId)
    .flatMap((s) => s.diagnostics)
    .filter((d) => !(d.kind === 'decision-mismatch' && d.seq !== null && knownDecisionSeqs.includes(d.seq)));
}

function upserts(ops: readonly SessionOp[]): TranscriptItem[] {
  return ops.flatMap((op) => (op.op === 'item.upsert' ? [op.item] : []));
}

function runStates(h: EngineHarness, entryId: string): string[] {
  const states: string[] = [];
  for (const { summary } of h.publisher.summaries) {
    if (summary.entryId !== entryId) continue;
    if (states.at(-1) !== summary.status.runState) states.push(summary.status.runState);
  }
  return states;
}

describe('auth-probe', () => {
  it('create with prompt → starting → working → idle (done, unread), model, apiKeySource, context, log', async () => {
    const { h, parsed } = await setup('auth-probe');
    const entryId = await h.create(firstPrompt(parsed));
    await h.drive(entryId, parsed, { close: false });
    await h.waitFor(() => h.summary(entryId).context?.source === 'sdk');

    expect(runStates(h, entryId)).toEqual(['sleeping', 'starting', 'working', 'idle']);
    expect(h.status(entryId).kind).toBe('done');
    const summary = h.summary(entryId);
    expect(summary.status.unread).toBe(true);
    expect(summary.model).toMatch(/^claude-haiku/);
    expect(summary.apiKeySource).toBe('none');
    expect(summary.cliVersion).toBe('2.1.300');
    expect(summary.sessionId).toBe('a2aa36f5-56fb-42f9-af06-3db55a33470f');
    expect(summary.context?.totalTokens).toBeGreaterThan(0);
    expect(summary.lastResultExcerpt).toBe('OK');
    expect(summary.title).toBe('Reply with exactly: OK');
    expect(summary.titleSource).toBe('prompt');

    // Log: only final items; lastOrder = highest order written.
    const entry = h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('entry missing');
    const conv = currentConversation(entry);
    const lines = h.stores.transcripts.lines(entryId, conv.id);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      if (line.op !== 'upsert') continue;
      const item = line.item;
      if (item.kind === 'assistant_text' || item.kind === 'thinking') expect(item.streaming).toBe(false);
      if (item.kind === 'tool_call') expect(item.status).not.toBe('streaming_input');
    }
    const items = h.stores.transcripts.items(entryId, conv.id);
    expect(conv.lastOrder).toBe(Math.max(...upserts(h.publisher.opsOf(entryId)).map((i) => i.order)));
    expect(items.map((i) => i.kind)).toContain('user_message');
    expect(items.map((i) => i.kind)).toContain('turn_result');
    expect(entry.lastRunState).toBe('idle');
    expect(entry.unread).toBe(true);
    expect(unexpectedDiagnostics(h, entryId)).toEqual([]);

    // Close → sleeping (expected exit), process record removed.
    await h.cmd({ name: 'session.close', entryId });
    expect(h.summary(entryId).status.runState).toBe('sleeping');
    expect(h.stores.processes.records()).toEqual([]);
    expect(h.stores.processes.adds).toBe(1);
  });
});

function outcomes(h: EngineHarness, entryId: string) {
  return h.publisher.opsOf(entryId).flatMap((op) => (op.op === 'decision.resolved' ? [op.outcome] : []));
}

function toolStatuses(h: EngineHarness, entryId: string, toolUseId: string): string[] {
  const out: string[] = [];
  for (const item of upserts(h.publisher.opsOf(entryId))) {
    if (item.kind === 'tool_call' && item.toolUseId === toolUseId && out.at(-1) !== item.status)
      out.push(item.status);
  }
  return out;
}

describe('permissions', () => {
  it('allow once, remember session, deny with text, deny + interrupt, remember localSettings + acceptEdits', async () => {
    const { h, parsed } = await setup('permissions');
    const entryId = await h.create(firstPrompt(parsed));
    const checks: Record<string, unknown> = {};
    await h.drive(entryId, parsed, {
      onInput: (index) => {
        if (index === 3) {
          // Before the deny+interrupt turn: seen once (unread false), then nobody looks.
          h.manager.onPresenceChanged([
            {
              clientId: HARNESS_CLIENT_ID,
              presence: { focused: true, visible: true, viewingEntryId: entryId, typing: false },
              lastFocusAt: h.now(),
              connectedAt: h.now(),
            },
          ]);
          h.manager.onPresenceChanged([]);
        }
        if (index === 4) {
          const facts = h.facts(entryId);
          checks.afterInterrupt = {
            runState: facts.runState,
            unread: facts.unread,
            lastTurn: facts.lastTurn?.outcome,
            errorCode: facts.errorCode,
            lastError: h.summary(entryId).lastError,
          };
        }
        return false;
      },
    });

    expect(checks.afterInterrupt).toEqual({
      runState: 'idle',
      unread: false,
      lastTurn: 'interrupted',
      errorCode: null,
      lastError: null,
    });
    expect(outcomes(h, entryId)).toEqual([
      { type: 'allowed', remember: null, acceptEdits: false },
      { type: 'allowed', remember: 'session', acceptEdits: false },
      { type: 'allowed', remember: null, acceptEdits: false },
      { type: 'allowed', remember: null, acceptEdits: false },
      { type: 'allowed', remember: null, acceptEdits: false },
      { type: 'denied', withMessage: true, interrupt: false },
      { type: 'denied', withMessage: true, interrupt: true },
      { type: 'allowed', remember: 'localSettings', acceptEdits: true },
    ]);
    // ADR-012: the broker sends rules AND directories to the chosen destination (#46, #282).
    expect(unexpectedDiagnostics(h, entryId, [46, 282])).toEqual([]);
    expect(
      h
        .sessions(entryId)
        .flatMap((s) => s.diagnostics)
        .map((d) => d.seq),
    ).toEqual([46, 282]);
    expect(toolStatuses(h, entryId, 'toolu_017HddxmWoBefn6egFyGNKD5')).toEqual([
      'streaming_input',
      'pending',
      'awaiting_decision',
      'running',
      'done',
    ]);
    expect(toolStatuses(h, entryId, 'toolu_01NFYoKD2fuexwfd7YVkjqfg').at(-1)).toBe('denied');
    // remember localSettings + acceptEdits → the CLI switches the mode (system/status).
    expect(h.summary(entryId).permissionMode).toBe('acceptEdits');
    expect(runStates(h, entryId)).not.toContain('error');
    expect(h.summary(entryId).status.runState).toBe('sleeping');
  });
});

describe('permissions-rules', () => {
  it('a repeated request is a new decision each time (F.3)', async () => {
    const { h, parsed } = await setup('permissions-rules');
    const entryId = await h.create(firstPrompt(parsed));
    await h.drive(entryId, parsed);
    const created = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'decision.upsert' ? [op.decision] : []));
    const ruleDir = created.filter(
      (d) =>
        d.kind === 'permission' &&
        d.toolName === 'Bash' &&
        JSON.stringify(d.input).includes('mkdir -p rule-dir &&'),
    );
    expect(ruleDir).toHaveLength(2);
    expect(new Set(created.map((d) => d.id)).size).toBe(created.length);
    expect(created).toHaveLength(6);
    // #371: recorded only addRules → localSettings; the broker adds the offered directory too.
    expect(unexpectedDiagnostics(h, entryId, [371])).toEqual([]);
  });
});

describe('ask-user-question', () => {
  it('answer with a note → updatedInput equal to the recording, outcome answered', async () => {
    const { h, parsed } = await setup('ask-user-question');
    const entryId = await h.create(firstPrompt(parsed));
    await h.drive(entryId, parsed);
    expect(outcomes(h, entryId)).toEqual([{ type: 'answered' }]);
    expect(unexpectedDiagnostics(h, entryId)).toEqual([]);
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);
  });
});

describe('plan-mode', () => {
  it('v1 revise → v2 with previousVersionPlan, approve acceptEdits + edited plan, plans saved', async () => {
    const { h, parsed } = await setup('plan-mode');
    const entryId = await h.create(firstPrompt(parsed), { permissionMode: 'plan' });
    await h.drive(entryId, parsed);
    expect(h.backend.starts[0]?.permissionMode).toBe('plan');
    const plans = h.publisher
      .opsOf(entryId)
      .flatMap((op) => (op.op === 'decision.upsert' && op.decision.kind === 'plan' ? [op.decision] : []));
    expect(plans.map((p) => p.version)).toEqual([1, 2]);
    expect(plans[0]?.previousVersionPlan).toBeNull();
    expect(plans[1]?.previousVersionPlan).toBe(plans[0]?.plan);
    expect(outcomes(h, entryId)).toEqual([
      { type: 'plan_revised' },
      { type: 'plan_approved', mode: 'acceptEdits', edited: true },
    ]);
    expect(h.stores.decisions.plan(entryId, 1)).toBe(plans[0]?.plan);
    expect(h.stores.decisions.plan(entryId, 2)).toBe(plans[1]?.plan);
    // setMode destination session = the recording: no diagnostics at all.
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);
    const kinds: string[] = [];
    for (const { summary } of h.publisher.summaries) {
      if (summary.entryId !== entryId) continue;
      const kind = deriveDisplayStatus(summary.status, h.now()).kind;
      if (kinds.at(-1) !== kind) kinds.push(kind);
    }
    const review = kinds.lastIndexOf('needs-review');
    expect(review).toBeGreaterThan(0);
    expect(kinds[review + 1]).toBe('working');
    expect(h.summary(entryId).permissionMode).toBe('acceptEdits');
  });
});

describe('clear-rename', () => {
  const TITLE = 'Parallax Spike Title';
  const OLD_SESSION = 'f04bd9b2-88ce-404f-83e3-3367a23f9b8a';
  const NEW_SESSION = '9b779de6-73fd-4d10-8e3e-0580a3e09f7b';
  const CORRELATION = '96ce35cc-c220-4460-93cb-8ec96ab9cfd7';

  it('session.rename → /rename prompt, custom at once, echo; /clear → new conversation, id from init', async () => {
    const { h, parsed } = await setup('clear-rename');
    const entryId = await h.create(firstPrompt(parsed));
    const seen: Record<string, unknown> = {};
    await h.drive(entryId, parsed, {
      onInput: async (index) => {
        if (index !== 1) return false;
        await h.cmd({ name: 'session.rename', entryId, title: TITLE });
        seen.afterRename = { title: h.summary(entryId).title, source: h.summary(entryId).titleSource };
        seen.pending = h.manager.inspect(entryId)?.pendingRename;
        return true;
      },
    });
    expect(seen).toEqual({ afterRename: { title: TITLE, source: 'custom' }, pending: TITLE });
    expect(h.manager.inspect(entryId)?.pendingRename).toBeNull();
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);

    const ops = h.publisher.opsOf(entryId);
    const reset = ops.findIndex((op) => op.op === 'conversation.reset');
    const marker = ops.findIndex(
      (op) => op.op === 'item.upsert' && op.item.kind === 'system' && op.item.event === 'conversation_reset',
    );
    expect(reset).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(reset);

    const entry = h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('entry missing');
    expect(entry.conversations).toHaveLength(2);
    const [old, current] = entry.conversations;
    expect(old).toMatchObject({ sessionId: OLD_SESSION, endReason: 'clear', title: TITLE });
    expect(old?.endedAt).not.toBeNull();
    expect(current).toMatchObject({ sessionId: NEW_SESSION, resetCorrelationId: CORRELATION, endedAt: null });
    expect(current?.sessionId).not.toBe(CORRELATION);
    expect(entry.title).toBe(TITLE);
    expect(entry.titleSource).toBe('custom');
    // The reset op names both conversations; the marker is the first item of the new one.
    const resetOp = ops[reset];
    expect(resetOp).toEqual({
      op: 'conversation.reset',
      conversationId: current?.id,
      previousConversationId: old?.id,
      trigger: 'clear',
      hasEarlier: false,
    });
    const newItems = h.stores.transcripts.items(entryId, current?.id ?? '');
    expect(newItems[0]).toMatchObject({ kind: 'system', event: 'conversation_reset', order: 1 });
    expect(h.summary(entryId).sessionId).toBe(NEW_SESSION);
  });

  it('title_changed within the reset turn is ignored (the CLI echoes the old title)', async () => {
    const { h, parsed } = await setup('clear-rename');
    const entryId = await h.create(firstPrompt(parsed));
    await h.drive(entryId, parsed, {
      onInput: async (index) => {
        // After the /rename echo (custom): back to the automatic title before /clear.
        if (index === 2) await h.cmd({ name: 'session.rename', entryId, title: null });
        if (index === 3) {
          expect({ title: h.summary(entryId).title, source: h.summary(entryId).titleSource }).toEqual({
            title: '',
            source: 'none',
          });
        }
        return false;
      },
    });
    expect(h.summary(entryId).titleSource).toBe('prompt');
    expect(h.summary(entryId).title).toBe('Reply with exactly: TWO');
  });
});

describe('queue-priority', () => {
  it('next during Bash: sending → queued → gone; now: abort, background task, follow-up turn', async () => {
    const { h, parsed } = await setup('queue-priority');
    const entryId = await h.create(firstPrompt(parsed));
    await h.drive(entryId, parsed);
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);

    const sent = h.session(entryId).sent;
    expect(sent.map((p) => p.priority)).toEqual(['next', 'next', 'next', 'now']);
    const nextUuid = sent[1]?.uuid;
    const queueStates: string[] = [];
    for (const op of h.publisher.opsOf(entryId)) {
      if (op.op !== 'detail.patch' || op.patch.queue === undefined) continue;
      const prompt = op.patch.queue.find((p) => p.messageUuid === nextUuid);
      const state = prompt?.state ?? 'gone';
      if (queueStates.at(-1) !== state) queueStates.push(state);
    }
    expect(queueStates).toEqual(['gone', 'sending', 'queued', 'gone']);

    const entry = h.stores.registry.get(entryId);
    if (entry === undefined) throw new Error('entry missing');
    const items = h.stores.transcripts.items(entryId, currentConversation(entry).id);
    const prompts = items.filter((i) => i.kind === 'user_message').map((i) => i.id);
    expect(prompts).toEqual(sent.map((p) => p.uuid));
    const results = items.filter((i) => i.kind === 'turn_result').map((i) => i.outcome);
    expect(results).toContain('interrupted');
    expect(h.summary(entryId).status.lastTurn?.outcome).toBe('success');
    const background = h.publisher.summaries.some(
      (s) => s.summary.entryId === entryId && s.summary.status.backgroundTasks > 0,
    );
    expect(background).toBe(true);
    const kinds = displayKinds(h, entryId);
    expect(kinds).toContain('background');
    // "done" only once the follow-up turn of the background task is over (idle, no tasks).
    expect(kinds.lastIndexOf('done')).toBeGreaterThan(kinds.lastIndexOf('working'));
    expect(kinds.lastIndexOf('done')).toBeGreaterThan(kinds.lastIndexOf('background'));
  });
});

function displayKinds(h: EngineHarness, entryId: string): string[] {
  const kinds: string[] = [];
  for (const { summary } of h.publisher.summaries) {
    if (summary.entryId !== entryId) continue;
    const kind = deriveDisplayStatus(summary.status, h.now()).kind;
    if (kinds.at(-1) !== kind) kinds.push(kind);
  }
  return kinds;
}

describe.each(['interrupt', 'interrupt-requesting'])('%s', (name) => {
  it('session.interrupt at the gate → aborted turn, idle without unread, no error banner', async () => {
    const { h, parsed } = await setup(name);
    const entryId = await h.create(firstPrompt(parsed));
    const afterFirst: Record<string, unknown> = {};
    await h.drive(entryId, parsed, {
      onInput: (index) => {
        if (index === 1) {
          const facts = h.facts(entryId);
          Object.assign(afterFirst, {
            runState: facts.runState,
            unread: facts.unread,
            lastTurn: facts.lastTurn?.outcome,
            lastError: h.summary(entryId).lastError,
            kind: h.status(entryId).kind,
          });
        }
        return false;
      },
    });
    expect(afterFirst).toEqual({
      runState: 'idle',
      unread: false,
      lastTurn: 'interrupted',
      lastError: null,
      kind: 'idle',
    });
    expect(h.session(entryId).controls.filter((c) => c.method === 'interrupt').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);
    expect(runStates(h, entryId)).not.toContain('error');
  });
});

describe('subagent', () => {
  it('background badge, subagent items under the Agent tool call, done after the second result + idle', async () => {
    const { h, parsed } = await setup('subagent');
    const entryId = await h.create(firstPrompt(parsed));
    await h.drive(entryId, parsed, { close: false });
    const agent = 'toolu_013x5wt9ahrMarqiBjss5AtL';
    const items = upserts(h.publisher.opsOf(entryId));
    const nested = items.filter((i) => i.parentToolUseId === agent);
    expect(nested.length).toBeGreaterThan(0);
    expect(
      h.publisher.summaries.some(
        (s) => s.summary.entryId === entryId && s.summary.status.backgroundTasks > 0,
      ),
    ).toBe(true);
    const kinds = displayKinds(h, entryId);
    expect(kinds.filter((k) => k === 'done')).toHaveLength(1);
    expect(kinds.at(-1)).toBe('done');
    const results = items.filter((i) => i.kind === 'turn_result');
    expect(new Set(results.map((r) => r.id)).size).toBe(2);
  });
});

describe('resume', () => {
  const SESSION = 'a2aa36f5-56fb-42f9-af06-3db55a33470f';

  async function resumeWith(mode: 'default' | 'bypassPermissions', allowsBypass: boolean) {
    const parsed = await loadFixtureScenario('resume');
    const entry = sampleEntry({
      id: sampleId('en', 7),
      conversations: [sampleConversation({ id: sampleId('cv', 7), sessionId: SESSION, lastOrder: 0 })],
      permissionMode: mode,
      lastRunState: 'sleeping',
      modelSetting: null,
    });
    const h = await createEngineHarness({
      scenario: () => fixtureScenario(parsed),
      seed: { entries: [entry] },
      allowsBypass,
    });
    harness = h;
    return { h, parsed, entryId: entry.id };
  }

  it('an entry with session id + mode resumes with both', async () => {
    const { h, parsed, entryId } = await resumeWith('default', false);
    await h.cmd({ name: 'session.sendPrompt', entryId, prompt: { text: 'Reply with exactly: RESUMED' } });
    await h.drive(entryId, parsed);
    expect(h.backend.starts[0]).toMatchObject({
      resumeSessionId: SESSION,
      permissionMode: 'default',
      model: null,
    });
    expect(h.summary(entryId).lastResultExcerpt).toBe('RESUMED');
    expect(h.sessions(entryId).flatMap((s) => s.diagnostics)).toEqual([]);
  });

  it('a stored bypassPermissions is dropped without allowsBypass (C.3), kept with it', async () => {
    const without = await resumeWith('bypassPermissions', false);
    await without.h.cmd({ name: 'session.resume', entryId: without.entryId });
    expect(without.h.backend.starts[0]?.permissionMode).toBeNull();
    await without.h.close();

    const allowed = await resumeWith('bypassPermissions', true);
    await allowed.h.cmd({ name: 'session.resume', entryId: allowed.entryId });
    expect(allowed.h.backend.starts[0]?.permissionMode).toBe('bypassPermissions');
  });
});

describe('history as source', () => {
  it('loadView of a dormant entry without log → readHistory → normalizeHistory, imported once', async () => {
    const parsed = await loadFixtureScenario('history');
    const history = createFakeHistoryStore();
    history.seedFromHistoryFixture(parsed);
    const entry = sampleEntry({
      id: sampleId('en', 8),
      conversations: [
        sampleConversation({ id: sampleId('cv', 8), sessionId: 'a81548fd-0d35-40a2-97f8-c4091b6bd31c' }),
      ],
      lastRunState: 'sleeping',
    });
    const h = await createEngineHarness({ seed: { entries: [entry] }, history });
    harness = h;
    const spy = vi.spyOn(h.backend, 'readHistory');
    const view = await h.manager.loadView(entry.id);
    expect(view?.items.length).toBeGreaterThan(10);
    expect(view?.items.some((i) => i.kind === 'tool_call')).toBe(true);
    const logged = h.stores.transcripts.items(entry.id, sampleId('cv', 8));
    expect(logged.length).toBe(view?.items.length);
    const stored = h.stores.registry.get(entry.id);
    expect(currentConversation(stored ?? entry).lastOrder).toBe(Math.max(...logged.map((i) => i.order)));

    // Mirror dropped (no subscribers, no process) → the next load reads the log, not the history.
    h.manager.onSubscribersChanged(entry.id, 0);
    const again = await h.manager.loadView(entry.id);
    expect(again?.items.map((i) => i.id)).toEqual(view?.items.map((i) => i.id));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
