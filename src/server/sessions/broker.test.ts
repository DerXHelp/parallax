import { describe, expect, it, vi } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  jsonValueSchema,
  type ClientId,
  type ConversationId,
  type DecisionKind,
  type PermissionMode,
} from '@shared/common';
import type { DecisionRecord, ToolCallItem, ToolDecisionRef } from '@shared/model';
import {
  SAMPLE_IDS,
  SAMPLE_TIME,
  sampleDecisionRecord,
  sampleDecisions,
  sampleId,
  sampleItems,
} from '@shared/samples';
import type { DecisionCounts } from '@shared/status';
import type { PermissionRequest } from '../backend/types';
import { CommandError } from '../sync/ports';
import { createBroker, type Broker } from './broker';
import { BROKER_MESSAGES } from './brokerRules';
import { createMemoryPublisher } from './testing/memoryPublisher';
import { createMemoryStores } from './testing/memoryStores';

const ENTRY = SAMPLE_IDS.entry;
const CLIENT_1: ClientId = sampleId('cl', 1);
const CLIENT_2: ClientId = sampleId('cl', 2);

interface SetupOptions {
  mode?: PermissionMode | null;
  allowsBypass?: boolean;
  supportsAutoMode?: boolean;
  toolCalls?: ToolCallItem[];
  recordsKeep?: number;
  seed?: DecisionRecord[];
}

function setup(o: SetupOptions = {}) {
  const stores = createMemoryStores(
    o.seed === undefined ? {} : { decisions: [{ entryId: ENTRY, records: o.seed }] },
  );
  const publisher = createMemoryPublisher();
  const attached: { toolUseId: string; ref: ToolDecisionRef }[] = [];
  const countsLog: { counts: DecisionCounts; added: DecisionKind | null }[] = [];
  const capInput = vi.fn((input: Record<string, unknown>) => ({
    input: jsonValueSchema.parse(input),
    truncated: null,
  }));
  const conversation: ConversationId = sampleId('cv', 1);
  const state = { conversation, mode: o.mode ?? 'default', tick: 0, ids: 0 };
  const toolCalls = new Map((o.toolCalls ?? []).map((t) => [t.toolUseId, t]));
  const broker: Broker = createBroker({
    entryId: ENTRY,
    now: () => new Date(Date.parse(SAMPLE_TIME) + (state.tick += 1) * 1000),
    newDecisionId: () => sampleId('dc', (state.ids += 1)),
    store: stores.decisions,
    conversationId: () => state.conversation,
    permissionMode: () => state.mode,
    allowsBypass: () => o.allowsBypass ?? false,
    supportsAutoMode: () => o.supportsAutoMode ?? true,
    findToolCall: (id) => toolCalls.get(id) ?? null,
    capInput,
    emit: (ops) => {
      publisher.publishOps(ENTRY, ops);
    },
    attachDecision: (toolUseId, ref) => {
      attached.push({ toolUseId, ref });
    },
    onCountsChanged: (counts, added) => {
      countsLog.push({ counts, added });
    },
    ...(o.recordsKeep === undefined ? {} : { recordsKeep: o.recordsKeep }),
  });
  return { broker, stores, publisher, attached, countsLog, capInput, state, toolCalls };
}

function request(p: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolName: 'Bash',
    input: { command: 'mkdir build', description: 'Create build folder' },
    toolUseId: 'toolu_1',
    requestId: 'req_1',
    agentId: null,
    suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'mkdir build' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
    blockedPath: null,
    decisionReason: null,
    decisionReasonType: 'other',
    title: null,
    displayName: 'Bash',
    description: 'Create build folder',
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
    requiresUserInteraction: false,
    mcpServer: null,
    raw: {},
    ...p,
  };
}

const planRequest = (toolUseId: string, plan: string): PermissionRequest =>
  request({
    toolName: 'ExitPlanMode',
    toolUseId,
    input: { plan, planFilePath: 'C:\\plans\\p.md' },
    suggestions: [],
  });

const allowOnce = {
  kind: 'permission',
  response: { behavior: 'allow', remember: null, acceptEdits: false },
} as const;

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (error instanceof CommandError) return error.error.code;
    throw error;
  }
}

describe('broker – creating a decision', () => {
  it('publishes decision.upsert, attaches the ref, saves the snapshot, reports counts with the new kind', () => {
    const t = setup();
    void t.broker.handler(request(), new AbortController().signal);
    const [op] = t.publisher.opsOf(ENTRY);
    expect(op?.op).toBe('decision.upsert');
    const decision = t.broker.open()[0];
    expect(decision).toMatchObject({
      id: sampleId('dc', 1),
      entryId: ENTRY,
      conversationId: sampleId('cv', 1),
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      kind: 'permission',
      state: 'open',
      requester: { kind: 'main' },
      input: { command: 'mkdir build', description: 'Create build folder' },
      displayName: 'Bash',
      decisionReasonType: 'other',
      offer: { rules: [{ toolName: 'Bash', ruleContent: 'mkdir build' }], acceptEdits: true },
    });
    expect(t.attached).toEqual([
      {
        toolUseId: 'toolu_1',
        ref: { decisionId: sampleId('dc', 1), kind: 'permission', planVersion: null, outcome: null },
      },
    ]);
    expect(t.countsLog.at(-1)).toEqual({
      counts: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
      added: 'permission',
    });
    const [record] = t.stores.decisions.records(ENTRY);
    expect(record).toMatchObject({
      id: sampleId('dc', 1),
      outcome: null,
      resolvedAt: null,
      planVersion: null,
    });
    expect(record?.decision).toEqual(decision);
  });

  it('offer.acceptEdits follows the actual mode', () => {
    const t = setup({ mode: 'acceptEdits' });
    void t.broker.handler(request(), new AbortController().signal);
    expect(t.broker.open()[0]).toMatchObject({ offer: { acceptEdits: false } });
  });

  it('input from the mirror tool call (already capped), else capInput', () => {
    const toolCall = sampleItems.toolCall({
      toolUseId: 'toolu_1',
      input: { command: 'capped' },
      inputTruncated: { totalChars: 100_000, blobId: SAMPLE_IDS.blob },
    });
    const t = setup({ toolCalls: [toolCall] });
    void t.broker.handler(request(), new AbortController().signal);
    expect(t.broker.open()[0]).toMatchObject({
      input: { command: 'capped' },
      inputTruncated: { totalChars: 100_000 },
    });
    expect(t.capInput).not.toHaveBeenCalled();
    void t.broker.handler(request({ toolUseId: 'toolu_2' }), new AbortController().signal);
    expect(t.capInput).toHaveBeenCalledTimes(1);
  });

  it('requester: subagent from the mirror (parent tool call + Agent description) or agentId', () => {
    const agent = sampleItems.toolCall({
      toolUseId: 'toolu_agent',
      toolName: 'Agent',
      input: { description: 'Find usages', prompt: 'x' },
    });
    const inner = sampleItems.toolCall({ toolUseId: 'toolu_inner', parentToolUseId: 'toolu_agent' });
    const t = setup({ toolCalls: [agent, inner] });
    void t.broker.handler(request({ toolUseId: 'toolu_inner' }), new AbortController().signal);
    void t.broker.handler(
      request({ toolUseId: 'toolu_x', agentId: 'agent-7' }),
      new AbortController().signal,
    );
    const [first, second] = t.broker.open();
    expect(first?.requester).toEqual({
      kind: 'subagent',
      agentId: 'toolu_agent',
      parentToolUseId: 'toolu_agent',
      description: 'Find usages',
    });
    expect(second?.requester).toEqual({
      kind: 'subagent',
      agentId: 'agent-7',
      parentToolUseId: null,
      description: null,
    });
  });

  it('question: parsed questions; unusable input → permission card', () => {
    const t = setup();
    const questions = {
      questions: [
        {
          question: 'Color?',
          header: 'C',
          multiSelect: false,
          options: [{ label: 'Red', description: 'r', preview: null }],
        },
      ],
    };
    void t.broker.handler(
      request({ toolName: 'AskUserQuestion', toolUseId: 'q1', input: questions, suggestions: [] }),
      new AbortController().signal,
    );
    void t.broker.handler(
      request({ toolName: 'AskUserQuestion', toolUseId: 'q2', input: { questions: 'x' }, suggestions: [] }),
      new AbortController().signal,
    );
    const [q1, q2] = t.broker.open();
    expect(q1).toMatchObject({ kind: 'question', questions: questions.questions });
    expect(q2?.kind).toBe('permission');
    expect(t.broker.counts()).toEqual({
      permission: 1,
      question: 1,
      plan: 0,
      oldestKind: 'question',
      expired: 0,
    });
  });

  it('an already aborted signal → immediate deny, no decision', async () => {
    const t = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(t.broker.handler(request(), controller.signal)).resolves.toMatchObject({ behavior: 'deny' });
    expect(t.broker.open()).toEqual([]);
    expect(t.publisher.opsOf(ENTRY)).toEqual([]);
  });
});

describe('broker – responding', () => {
  it('allow: resolves the SDK promise, decision.resolved with byClientId, outcome on the tool call, record closed', async () => {
    const t = setup();
    const promise = t.broker.handler(request(), new AbortController().signal);
    const result = t.broker.respond(sampleId('dc', 1), allowOnce, CLIENT_1);
    expect(result).toEqual({
      kind: 'resolved',
      outcome: { type: 'allowed', remember: null, acceptEdits: false },
    });
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'mkdir build', description: 'Create build folder' },
      decisionClassification: 'user_temporary',
    });
    expect(t.publisher.opsOf(ENTRY).at(-1)).toMatchObject({
      op: 'decision.resolved',
      decisionId: sampleId('dc', 1),
      outcome: { type: 'allowed' },
      byClientId: CLIENT_1,
    });
    expect(t.attached.at(-1)?.ref.outcome).toEqual({ type: 'allowed', remember: null, acceptEdits: false });
    expect(t.stores.decisions.records(ENTRY)[0]).toMatchObject({
      outcome: { type: 'allowed' },
      decision: null,
    });
    expect(t.broker.open()).toEqual([]);
    expect(t.countsLog.at(-1)).toEqual({
      counts: { permission: 0, question: 0, plan: 0, oldestKind: null, expired: 0 },
      added: null,
    });
  });

  it('updatedInput comes from the uncapped original input', async () => {
    const toolCall = sampleItems.toolCall({ toolUseId: 'toolu_1', input: { content: 'cut' } });
    const t = setup({ toolCalls: [toolCall] });
    const full = { content: 'x'.repeat(60_000) };
    const promise = t.broker.handler(
      request({ toolName: 'Write', input: full, suggestions: [] }),
      new AbortController().signal,
    );
    t.broker.respond(sampleId('dc', 1), allowOnce, null);
    const result: PermissionResult = await promise;
    expect(result.behavior === 'allow' ? result.updatedInput : null).toBe(full);
  });

  it('first click wins: the second answer gets DECISION_ALREADY_RESOLVED, byClientId stays the first', async () => {
    const t = setup();
    const promise = t.broker.handler(request(), new AbortController().signal);
    t.broker.respond(sampleId('dc', 1), allowOnce, CLIENT_1);
    expect(
      errorCode(() =>
        t.broker.respond(
          sampleId('dc', 1),
          { kind: 'permission', response: { behavior: 'deny', message: '', interrupt: false } },
          CLIENT_2,
        ),
      ),
    ).toBe('DECISION_ALREADY_RESOLVED');
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
    const resolved = t.publisher.opsOf(ENTRY).filter((op) => op.op === 'decision.resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ byClientId: CLIENT_1 });
  });

  it('unknown id → DECISION_NOT_FOUND; invalid option → DECISION_OPTION_UNAVAILABLE (decision stays open)', () => {
    const t = setup();
    void t.broker.handler(request({ suggestions: [] }), new AbortController().signal);
    expect(errorCode(() => t.broker.respond(sampleId('dc', 99), allowOnce, null))).toBe('DECISION_NOT_FOUND');
    expect(
      errorCode(() =>
        t.broker.respond(
          sampleId('dc', 1),
          { kind: 'permission', response: { behavior: 'allow', remember: 'session', acceptEdits: false } },
          null,
        ),
      ),
    ).toBe('DECISION_OPTION_UNAVAILABLE');
    expect(t.broker.open()).toHaveLength(1);
  });

  it('signal abort removes the card (cancelled signal_aborted); a later answer → DECISION_ALREADY_RESOLVED', async () => {
    const t = setup();
    const controller = new AbortController();
    const promise = t.broker.handler(request(), controller.signal);
    controller.abort();
    await expect(promise).resolves.toEqual({
      behavior: 'deny',
      message: BROKER_MESSAGES.cancelled,
      interrupt: false,
    });
    expect(t.publisher.opsOf(ENTRY).at(-1)).toMatchObject({
      op: 'decision.resolved',
      outcome: { type: 'cancelled', reason: 'signal_aborted' },
      byClientId: null,
    });
    expect(t.broker.open()).toEqual([]);
    expect(errorCode(() => t.broker.respond(sampleId('dc', 1), allowOnce, CLIENT_1))).toBe(
      'DECISION_ALREADY_RESOLVED',
    );
  });

  it('several open decisions: counts per kind, oldestKind, answers in any order', async () => {
    const t = setup();
    const a = t.broker.handler(request({ toolUseId: 'a' }), new AbortController().signal);
    const b = t.broker.handler(planRequest('b', '# Plan'), new AbortController().signal);
    expect(t.broker.counts()).toEqual({
      permission: 1,
      question: 0,
      plan: 1,
      oldestKind: 'permission',
      expired: 0,
    });
    expect(t.countsLog.at(-1)?.added).toBe('plan');
    t.broker.respond(
      sampleId('dc', 2),
      { kind: 'plan', response: { behavior: 'revise', feedback: 'more' } },
      null,
    );
    expect(t.broker.counts()).toMatchObject({ permission: 1, plan: 0, oldestKind: 'permission' });
    t.broker.respond(sampleId('dc', 1), allowOnce, null);
    await expect(Promise.all([a, b])).resolves.toMatchObject([
      { behavior: 'allow' },
      { behavior: 'deny', message: 'more' },
    ]);
  });
});

describe('broker – cancel', () => {
  it('interrupt: all open with {deny, interrupt:true}, outcome cancelled/interrupted', async () => {
    const t = setup();
    const main = t.broker.handler(request({ toolUseId: 'm' }), new AbortController().signal);
    const sub = t.broker.handler(
      request({ toolUseId: 's', agentId: 'agent-1' }),
      new AbortController().signal,
    );
    t.broker.cancel('all', 'interrupted', 'deny-interrupt');
    const expected = {
      behavior: 'deny',
      message: BROKER_MESSAGES.interrupted,
      interrupt: true,
      decisionClassification: 'user_reject',
    };
    await expect(main).resolves.toEqual(expected);
    await expect(sub).resolves.toEqual(expected);
    const outcomes = t.publisher
      .opsOf(ENTRY)
      .flatMap((op) => (op.op === 'decision.resolved' ? [op.outcome] : []));
    expect(outcomes).toEqual([
      { type: 'cancelled', reason: 'interrupted' },
      { type: 'cancelled', reason: 'interrupted' },
    ]);
    expect(t.broker.counts().oldestKind).toBeNull();
  });

  it("prompt 'now': only the main agent's decisions, deny without interrupt", async () => {
    const t = setup();
    const main = t.broker.handler(request({ toolUseId: 'm' }), new AbortController().signal);
    void t.broker.handler(request({ toolUseId: 's', agentId: 'agent-1' }), new AbortController().signal);
    t.broker.cancel('main', 'interrupted', 'deny');
    await expect(main).resolves.toEqual({
      behavior: 'deny',
      message: BROKER_MESSAGES.newMessage,
      interrupt: false,
      decisionClassification: 'user_reject',
    });
    expect(t.broker.open().map((d) => d.toolUseId)).toEqual(['s']);
  });

  it.each(['process_exit', 'conversation_reset'] as const)(
    '%s → cancelled with that reason',
    async (reason) => {
      const t = setup();
      const promise = t.broker.handler(request(), new AbortController().signal);
      t.broker.cancel('all', reason, 'deny');
      await expect(promise).resolves.toMatchObject({ behavior: 'deny', message: BROKER_MESSAGES.cancelled });
      expect(t.stores.decisions.records(ENTRY)[0]?.outcome).toEqual({ type: 'cancelled', reason });
    },
  );

  it('without open decisions: no ops, no counts', () => {
    const t = setup();
    t.broker.cancel('all', 'process_exit', 'deny');
    expect(t.publisher.opsOf(ENTRY)).toEqual([]);
    expect(t.countsLog).toEqual([]);
  });
});

describe('broker – plans', () => {
  it('versions are monotonic per entry, previousVersionPlan only within the conversation, plans saved', async () => {
    const t = setup({ allowsBypass: true, supportsAutoMode: false });
    void t.broker.handler(planRequest('p1', 'v1 text'), new AbortController().signal);
    t.broker.respond(
      sampleId('dc', 1),
      { kind: 'plan', response: { behavior: 'revise', feedback: 'again' } },
      null,
    );
    void t.broker.handler(planRequest('p2', 'v2 text'), new AbortController().signal);
    t.state.conversation = sampleId('cv', 2);
    void t.broker.handler(planRequest('p3', 'v3 text'), new AbortController().signal);
    const [v2, v3] = t.broker.open();
    expect(v2).toMatchObject({
      kind: 'plan',
      version: 2,
      previousVersionPlan: 'v1 text',
      planFilePath: 'C:\\plans\\p.md',
    });
    expect(v3).toMatchObject({
      kind: 'plan',
      version: 3,
      previousVersionPlan: null,
      conversationId: sampleId('cv', 2),
    });
    expect(v2?.kind === 'plan' ? v2.approveModes : null).toEqual([
      'acceptEdits',
      'default',
      'bypassPermissions',
    ]);
    expect(t.attached.find((a) => a.toolUseId === 'p3')?.ref.planVersion).toBe(3);
    await vi.waitFor(() => {
      expect(t.stores.decisions.plan(ENTRY, 3)).toBe('v3 text');
    });
    expect(t.stores.decisions.plan(ENTRY, 1)).toBe('v1 text');
    expect(t.stores.decisions.records(ENTRY).map((r) => r.planVersion)).toEqual([1, 2, 3]);
  });
});

describe('broker – persistence, restore, expired, freeze', () => {
  it('snapshot only while open; keeps all open and the last recordsKeep resolved', () => {
    const t = setup({ recordsKeep: 2 });
    for (let i = 1; i <= 4; i += 1) {
      void t.broker.handler(request({ toolUseId: `t${String(i)}` }), new AbortController().signal);
      t.broker.respond(sampleId('dc', i), allowOnce, null);
    }
    void t.broker.handler(request({ toolUseId: 'open' }), new AbortController().signal);
    const records = t.stores.decisions.records(ENTRY);
    expect(records.map((r) => r.toolUseId)).toEqual(['t3', 't4', 'open']);
    expect(records.map((r) => r.decision === null)).toEqual([true, true, false]);
    // The trimmed ones are unknown now, the kept ones already resolved.
    expect(errorCode(() => t.broker.respond(sampleId('dc', 1), allowOnce, null))).toBe('DECISION_NOT_FOUND');
    expect(errorCode(() => t.broker.respond(sampleId('dc', 4), allowOnce, null))).toBe(
      'DECISION_ALREADY_RESOLVED',
    );
  });

  it('restore: open records with snapshot → expired cards, without → counted only and closed; resolved stay resolved', () => {
    const plan = sampleDecisions.plan({
      id: sampleId('dc', 10),
      version: 4,
      createdAt: '2026-10-15T07:00:01.000Z',
    });
    const withSnapshot = sampleDecisionRecord({
      id: plan.id,
      decision: plan,
      planVersion: 4,
      createdAt: plan.createdAt,
    });
    const withoutSnapshot = sampleDecisionRecord({
      id: sampleId('dc', 11),
      kind: 'permission',
      toolName: 'Bash',
      planVersion: null,
      planFilePath: null,
      decision: null,
      createdAt: '2026-10-15T07:00:02.000Z',
    });
    const resolved = sampleDecisionRecord({
      id: sampleId('dc', 12),
      outcome: { type: 'plan_revised' },
      resolvedAt: '2026-10-15T07:00:00.500Z',
      decision: null,
      planVersion: 3,
      createdAt: '2026-10-15T07:00:00.000Z',
    });
    const t = setup({ seed: [] });
    expect(t.broker.restore([withSnapshot, withoutSnapshot, resolved])).toEqual({ hadOpen: true });
    expect(t.broker.expired()).toEqual([{ ...plan, state: 'expired' }]);
    expect(t.broker.open()).toEqual([]);
    expect(t.broker.counts()).toEqual({ permission: 0, question: 0, plan: 0, oldestKind: null, expired: 2 });
    expect(t.publisher.opsOf(ENTRY)).toEqual([]);
    const saved = t.stores.decisions.records(ENTRY);
    expect(saved.find((r) => r.id === sampleId('dc', 11))?.outcome).toEqual({ type: 'expired' });
    expect(saved.find((r) => r.id === sampleId('dc', 10))?.outcome).toBeNull();
    // Answers on the expired card: everything but plan approve → DECISION_EXPIRED; resolved → already resolved.
    expect(
      errorCode(() =>
        t.broker.respond(plan.id, { kind: 'plan', response: { behavior: 'revise', feedback: 'x' } }, null),
      ),
    ).toBe('DECISION_EXPIRED');
    expect(errorCode(() => t.broker.respond(sampleId('dc', 12), allowOnce, null))).toBe(
      'DECISION_ALREADY_RESOLVED',
    );
    // Plan versions continue after the highest restored one.
    void t.broker.handler(planRequest('p', 'next'), new AbortController().signal);
    expect(t.broker.open()[0]).toMatchObject({ version: 5 });
  });

  it('restore without open records → hadOpen false', () => {
    const t = setup();
    expect(
      t.broker.restore([
        sampleDecisionRecord({ outcome: { type: 'expired' }, resolvedAt: SAMPLE_TIME, decision: null }),
      ]),
    ).toEqual({
      hadOpen: false,
    });
    expect(t.broker.counts().expired).toBe(0);
  });

  it('closeExpired: decision.resolved {expired} per card, counter → 0, records closed', () => {
    const plan = sampleDecisions.plan({ id: sampleId('dc', 10) });
    const t = setup();
    t.broker.restore([
      sampleDecisionRecord({ id: plan.id, decision: plan }),
      sampleDecisionRecord({ id: sampleId('dc', 11), decision: null }),
    ]);
    t.broker.closeExpired(CLIENT_1);
    expect(t.publisher.opsOf(ENTRY)).toEqual([
      {
        op: 'decision.resolved',
        decisionId: plan.id,
        outcome: { type: 'expired' },
        byClientId: CLIENT_1,
        at: expect.any(String) as string,
      },
    ]);
    expect(t.broker.counts().expired).toBe(0);
    expect(t.broker.expired()).toEqual([]);
    expect(t.stores.decisions.records(ENTRY).every((r) => r.outcome !== null && r.decision === null)).toBe(
      true,
    );
    expect(t.countsLog.at(-1)?.counts.expired).toBe(0);
    // Nothing left: a second call is silent.
    const before = t.countsLog.length;
    t.broker.closeExpired(null);
    expect(t.countsLog).toHaveLength(before);
  });

  it('expired plan approve → resume-and-approve (claimed), releaseExpired, resolveExpired', () => {
    const plan = sampleDecisions.plan({ id: sampleId('dc', 10), approveModes: ['acceptEdits', 'default'] });
    const t = setup();
    t.broker.restore([sampleDecisionRecord({ id: plan.id, decision: plan })]);
    const approve = {
      kind: 'plan',
      response: { behavior: 'approve', mode: 'acceptEdits', editedPlan: null },
    } as const;
    expect(t.broker.respond(plan.id, approve, CLIENT_1)).toEqual({
      kind: 'resume-and-approve',
      decision: { ...plan, state: 'expired' },
      mode: 'acceptEdits',
    });
    // Claimed: a second click loses, closeExpired (session start) skips it.
    expect(errorCode(() => t.broker.respond(plan.id, approve, CLIENT_2))).toBe('DECISION_ALREADY_RESOLVED');
    t.broker.closeExpired(null);
    expect(t.broker.expired()).toHaveLength(1);
    // Resume failed → clickable again.
    t.broker.releaseExpired(plan.id);
    expect(t.broker.respond(plan.id, approve, CLIENT_2)).toMatchObject({ kind: 'resume-and-approve' });
    t.broker.resolveExpired(plan.id, { type: 'plan_approved', mode: 'acceptEdits', edited: false }, CLIENT_2);
    expect(t.publisher.opsOf(ENTRY).at(-1)).toMatchObject({
      op: 'decision.resolved',
      decisionId: plan.id,
      outcome: { type: 'plan_approved', mode: 'acceptEdits', edited: false },
      byClientId: CLIENT_2,
    });
    expect(t.broker.counts().expired).toBe(0);
    expect(t.stores.decisions.records(ENTRY)[0]?.outcome).toMatchObject({ type: 'plan_approved' });
    // Not claimed (any more): no-ops.
    t.broker.resolveExpired(plan.id, { type: 'expired' }, null);
    t.broker.releaseExpired(plan.id);
    expect(t.broker.expired()).toEqual([]);
  });

  it('freeze: no cancel, no save; an abort after freeze releases the SDK but the record stays open', async () => {
    const t = setup();
    const controller = new AbortController();
    const promise = t.broker.handler(request(), controller.signal);
    const saves = t.stores.decisions.saves;
    t.broker.freeze();
    t.broker.cancel('all', 'process_exit', 'deny');
    expect(t.broker.open()).toHaveLength(1);
    controller.abort();
    await expect(promise).resolves.toMatchObject({ behavior: 'deny' });
    expect(t.broker.open()).toHaveLength(1);
    expect(t.stores.decisions.saves).toBe(saves);
    expect(t.stores.decisions.records(ENTRY)[0]).toMatchObject({ outcome: null });
    expect(t.stores.decisions.records(ENTRY)[0]?.decision).not.toBeNull();
    // A restart (new broker on the same store) shows the card as expired.
    const restarted = setup({ seed: t.stores.decisions.records(ENTRY) });
    expect(restarted.broker.restore(await restarted.stores.decisions.load(ENTRY))).toEqual({ hadOpen: true });
    expect(restarted.broker.expired()).toHaveLength(1);
    expect(restarted.broker.counts().expired).toBe(1);
  });
});
