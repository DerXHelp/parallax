import { describe, expect, it } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { SAMPLE_IDS, sampleUuid } from '@shared/samples';
import { fixtureInputPayloadSchema, type FixtureEvent } from './fixture';
import type {
  AgentSession,
  BackendEvent,
  OutgoingPrompt,
  PermissionHandler,
  StartSessionRequest,
} from './types';
import { mapUuids } from './fake/common';
import {
  closeGate,
  crash,
  dslContext,
  events,
  input,
  permissionStep,
  textTurn,
  toEvents,
  toolUseBlock,
} from './fake/dsl';
import {
  driveFixtureSession,
  fixtureDecisionResponder,
  loadFixtureScenario,
  recordedPrompts,
} from './fake/testing';
import { createFakeClaudeIntegration } from './fake/integration';
import {
  createFakeBackend,
  eventsScenario,
  fixtureScenario,
  sequentialIds,
  type FakeBackend,
  type FakeScenario,
} from './fakeBackend';

const FIXTURES = [
  'ask-user-question',
  'auth-probe',
  'clear-rename',
  'history',
  'interrupt',
  'interrupt-requesting',
  'permissions',
  'permissions-rules',
  'plan-mode',
  'queue-priority',
  'resume',
  'subagent',
];

const launch = await createFakeClaudeIntegration().launchSpecFor('standard', SAMPLE_IDS.entry);

function request(canUseTool: PermissionHandler, p: Partial<StartSessionRequest> = {}): StartSessionRequest {
  return {
    entryId: SAMPLE_IDS.entry,
    cwd: 'D:\\work\\fake',
    launch,
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool,
    ...p,
  };
}

const allowAll: PermissionHandler = (req) =>
  Promise.resolve({ behavior: 'allow', updatedInput: req.input, decisionClassification: 'user_temporary' });

function prompt(text: string, n: number, priority: 'next' | 'now' = 'next'): OutgoingPrompt {
  return { uuid: sampleUuid(n), content: [{ type: 'text', text }], priority };
}

function start(
  backend: FakeBackend,
  handler: PermissionHandler = allowAll,
  p: Partial<StartSessionRequest> = {},
) {
  const agent = backend.start(request(handler, p));
  const handle = backend.sessions.at(-1);
  if (handle === undefined) throw new Error('no session handle');
  const collected: BackendEvent[] = [];
  const consumed = (async () => {
    for await (const event of agent.events) collected.push(event);
  })();
  return { agent, handle, collected, consumed };
}

function messages(collected: readonly BackendEvent[]): unknown[] {
  return collected.flatMap((e) => (e.type === 'message' ? [e.message] : []));
}

function single(
  name: string,
  ev: FixtureEvent[],
  options?: Parameters<typeof eventsScenario>[2],
): () => FakeScenario {
  return () => eventsScenario(name, ev, options);
}

describe('FakeBackend â€“ all recorded fixtures (Abnahme 13a)', () => {
  it.each(FIXTURES)('%s: exactly the recorded message sequence, no diagnostics', async (name) => {
    const parsed = await loadFixtureScenario(name);
    const backend = createFakeBackend({ scenario: () => fixtureScenario(parsed) });
    const ids = sequentialIds();
    const agent = backend.start(request(fixtureDecisionResponder(parsed)));
    const handle = backend.sessions[0];
    if (handle === undefined) throw new Error('no handle');
    const prompts = recordedPrompts(parsed.events, () => ids.uuid());
    const result = await driveFixtureSession(backend, agent, handle, prompts);

    // UUID mapping: recorded input uuid â†’ the uuid actually sent (in order).
    const recordedInputs = parsed.events
      .filter((e) => e.kind === 'input')
      .map((e) => fixtureInputPayloadSchema.parse(e.payload).uuid);
    const map = new Map(recordedInputs.map((uuid, i) => [uuid, result.sent[i]?.uuid ?? uuid]));
    const expected = parsed.events.filter((e) => e.kind === 'message').map((e) => mapUuids(e.payload, map));

    expect(handle.diagnostics).toEqual([]);
    expect(result.sent).toHaveLength(recordedInputs.length);
    expect(messages(result.events)).toEqual(expected);
    // spawned first, exit last and exactly once.
    expect(result.events[0]?.type).toBe('spawned');
    expect(result.events.at(-1)?.type).toBe('exit');
    expect(result.events.filter((e) => e.type === 'exit')).toHaveLength(1);
    const exit = result.events.at(-1);
    expect(exit).toMatchObject({ type: 'exit', expected: true });
    // Interrupt gates were served with the recorded answer.
    const interrupts = parsed.events.filter(
      (e) => e.kind === 'control' && JSON.stringify(e.payload).includes('"interrupt"'),
    );
    expect(handle.controls.filter((c) => c.method === 'interrupt')).toHaveLength(interrupts.length);
  });

  it('exit codes of the exit gate are the recorded ones (interrupt-requesting exits with 1)', async () => {
    const parsed = await loadFixtureScenario('interrupt-requesting');
    const promptIds = sequentialIds();
    const backend = createFakeBackend({ scenario: () => fixtureScenario(parsed) });
    const agent = backend.start(request(fixtureDecisionResponder(parsed)));
    const handle = backend.sessions[0];
    if (handle === undefined) throw new Error('no handle');
    const result = await driveFixtureSession(
      backend,
      agent,
      handle,
      recordedPrompts(parsed.events, () => promptIds.uuid()),
    );
    expect(result.events.at(-1)).toMatchObject({ type: 'exit', code: 1, expected: true });
    expect(handle.pid).toBe(16916);
  });
});

describe('FakeBackend â€“ gates', () => {
  const c = () => dslContext();

  it('input gate: waits for send(), maps the uuid, records the prompt in the history', async () => {
    const ctx = c();
    const ev = events(
      input(ctx, 'fixture-uuid-1', 'Hello'),
      textTurn(ctx, { prompt: 'fixture-uuid-1', text: 'Hi' }),
      closeGate(),
    );
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle, collected, consumed } = start(backend);
    await backend.settle();
    expect(handle.state).toBe('waiting-input');
    expect(messages(collected)).toEqual([]);
    agent.send(prompt('Hello', 7));
    await backend.settle();
    expect(handle.state).toBe('waiting-close');
    const lifecycle = messages(collected).find((m) => JSON.stringify(m).includes('command_lifecycle'));
    expect(lifecycle).toMatchObject({ command_uuid: sampleUuid(7) });
    expect(handle.diagnostics).toEqual([]);
    expect(backend.history.messages(handle.sessionId ?? '')).toContainEqual(
      expect.objectContaining({ uuid: sampleUuid(7), type: 'user' }),
    );
    await agent.close();
    await consumed;
    expect(collected.at(-1)).toMatchObject({ type: 'exit', code: 0, expected: true });
  });

  it('input mismatch (text/priority) â†’ diagnostics, no abort', async () => {
    const ctx = c();
    const ev = events(input(ctx, 'u1', 'Expected text'), textTurn(ctx, { prompt: 'u1', text: 'x' }));
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle } = start(backend);
    await backend.settle();
    agent.send(prompt('Other text', 1, 'now'));
    await backend.settle();
    expect(handle.diagnostics.map((d) => d.kind)).toEqual(['input-mismatch', 'input-mismatch']);
    expect(handle.state).toBe('waiting-input');
    await agent.close();
  });

  it('send() buffers before the gate; after the last gate â†’ unexpected-input; echo mode answers', async () => {
    const ctx = c();
    const backend = createFakeBackend({
      scenario: single('t', events(input(ctx, 'u1', 'A'), textTurn(ctx, { prompt: 'u1', text: 'a' }))),
    });
    const { agent, handle } = start(backend);
    agent.send(prompt('A', 1));
    await backend.settle();
    expect(handle.diagnostics).toEqual([]);
    agent.send(prompt('B', 2));
    await backend.settle();
    expect(handle.diagnostics.map((d) => d.kind)).toEqual(['unexpected-input']);
    await agent.close();

    const echo = createFakeBackend({ scenario: single('t', [], { onExhausted: 'echo' }) });
    const e = start(echo);
    e.agent.send(prompt('ping', 3));
    await echo.settle();
    expect(messages(e.collected)).toContainEqual(
      expect.objectContaining({ type: 'result', result: 'Echo: ping', user_message_uuids: [sampleUuid(3)] }),
    );
    await e.agent.close();
  });

  it('canUseTool gate: blocks until the handler answers; the decision event compares (mismatch â†’ diagnostic)', async () => {
    const ctx = c();
    const ev = events(
      toolUseBlock(ctx, 'Bash', { command: 'ls' }, { toolUseId: 'toolu_a' }),
      permissionStep(ctx, {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseId: 'toolu_a',
        decision: {
          behavior: 'allow',
          updatedInput: { command: 'ls' },
          decisionClassification: 'user_temporary',
        },
      }),
      textTurn(ctx, { prompt: null, text: 'after' }),
    );
    const holder: { answer: ((r: PermissionResult) => void) | null } = { answer: null };
    const handler: PermissionHandler = () =>
      new Promise((resolve) => {
        holder.answer = resolve;
      });
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle, collected } = start(backend, handler);
    await backend.settle();
    expect(handle.state).toBe('waiting-decision');
    expect(messages(collected).some((m) => JSON.stringify(m).includes('"after"'))).toBe(false);
    holder.answer?.({ behavior: 'deny', message: 'no' });
    await backend.settle();
    expect(handle.diagnostics).toMatchObject([
      { kind: 'decision-mismatch', message: 'behavior deny instead of allow' },
    ]);
    expect(messages(collected).some((m) => JSON.stringify(m).includes('"after"'))).toBe(true);
    await agent.close();
  });

  it('a throwing handler answers deny + error{control} + diagnostic (like the SdkBackend)', async () => {
    const ctx = c();
    const ev = permissionStep(ctx, { toolName: 'Bash', input: {}, toolUseId: 't1', decision: null });
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle, collected } = start(backend, () => Promise.reject(new Error('broken')));
    await backend.settle();
    expect(handle.diagnostics.map((d) => d.kind)).toEqual(['handler-error']);
    expect(collected.some((e) => e.type === 'error' && e.where === 'control' && e.message === 'broken')).toBe(
      true,
    );
    await agent.close();
  });

  it('parallel canUseTool does not block; the decision event is the join point', async () => {
    const ctx = c();
    const ev = events(
      permissionStep(ctx, {
        toolName: 'Bash',
        input: { n: 1 },
        toolUseId: 'p1',
        parallel: true,
        agentId: 'agent-1',
      }),
      permissionStep(ctx, {
        toolName: 'Bash',
        input: { n: 2 },
        toolUseId: 'p2',
        parallel: true,
        agentId: 'agent-2',
      }),
      toEvents([
        [
          'decision',
          { toolName: 'Bash', toolUseID: 'p2', result: { behavior: 'allow', updatedInput: { n: 2 } } },
        ],
      ]),
      toEvents([
        [
          'decision',
          { toolName: 'Bash', toolUseID: 'p1', result: { behavior: 'allow', updatedInput: { n: 1 } } },
        ],
      ]),
      closeGate(),
    );
    const pending = new Map<string, (r: PermissionResult) => void>();
    const handler: PermissionHandler = (req) =>
      new Promise((resolve) => {
        pending.set(req.toolUseId, resolve);
      });
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle } = start(backend, handler);
    await backend.settle();
    expect([...pending.keys()]).toEqual(['p1', 'p2']);
    expect(handle.state).toBe('waiting-decision');
    pending.get('p1')?.({ behavior: 'allow', updatedInput: { n: 1 } });
    await backend.settle();
    expect(handle.state).toBe('waiting-decision');
    pending.get('p2')?.({ behavior: 'allow', updatedInput: { n: 2 } });
    await backend.settle();
    expect(handle.state).toBe('waiting-close');
    expect(handle.diagnostics).toEqual([]);
    await agent.close();
  });

  it('control interrupt gate: waits for interrupt(), answers still_queued mapped; interrupt without gate â†’ {stillQueued:[]} + diagnostic', async () => {
    const ctx = c();
    const ev = events(
      input(ctx, 'u1', 'Go'),
      toEvents([['control', { method: 'interrupt', args: [], result: { still_queued: ['u1'] }, ms: 3 }]]),
      textTurn(ctx, { prompt: null, text: 'after' }),
    );
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle } = start(backend);
    await expect(agent.interrupt()).resolves.toEqual({ stillQueued: [] });
    expect(handle.diagnostics.map((d) => d.kind)).toEqual(['unexpected-interrupt']);
    agent.send(prompt('Go', 9));
    await backend.settle();
    expect(handle.state).toBe('waiting-control');
    await expect(agent.interrupt()).resolves.toEqual({ stillQueued: [sampleUuid(9)] });
    await backend.settle();
    expect(handle.state).toBe('waiting-input');
    await agent.close();
  });

  it('interrupt() before the player reached a coming gate pre-releases it', async () => {
    const ctx = c();
    const ev = events(
      textTurn(ctx, { prompt: null, text: 'streaming' }),
      toEvents([['control', { method: 'interrupt', args: [], result: { still_queued: [] }, ms: 3 }]]),
      closeGate(),
    );
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle } = start(backend);
    await expect(agent.interrupt()).resolves.toEqual({ stillQueued: [] });
    await backend.settle();
    expect(handle.state).toBe('waiting-close');
    expect(handle.diagnostics).toEqual([]);
    await agent.close();
  });

  it('close() at any time: stops playback, exit{code:0, expected:true}, aborts open signals afterwards', async () => {
    const ctx = c();
    const ev = permissionStep(ctx, { toolName: 'Bash', input: {}, toolUseId: 't1', decision: null });
    const seen: { signal: AbortSignal | null } = { signal: null };
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, collected, consumed } = start(backend, (_req, s) => {
      seen.signal = s;
      return new Promise(() => undefined);
    });
    await backend.settle();
    await agent.close();
    await consumed;
    expect(collected.at(-1)).toEqual({
      type: 'exit',
      code: 0,
      signal: null,
      expected: true,
      at: expect.any(Date) as Date,
    });
    expect(seen.signal?.aborted).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.signal?.aborted).toBe(true);
    expect(() => {
      agent.send(prompt('late', 1));
    }).toThrow('session closed');
    await expect(agent.interrupt()).rejects.toThrow('session closed');
    await agent.close(); // idempotent
  });

  it('crash(): exit{code, expected:false}; spontaneous exit event and crashAfterSeq', async () => {
    const ctx = c();
    const backend = createFakeBackend({ scenario: single('t', events(input(ctx, 'u', 'x'))) });
    const a = start(backend);
    await backend.settle();
    a.handle.crash(5);
    await a.consumed;
    expect(a.collected.at(-1)).toMatchObject({ type: 'exit', code: 5, expected: false });

    const spontaneous = createFakeBackend({
      scenario: single('t', events(textTurn(ctx, { prompt: null, text: 'x' }), crash(3))),
    });
    const b = start(spontaneous);
    await b.consumed;
    expect(b.collected.at(-1)).toMatchObject({ type: 'exit', code: 3, expected: false });
    expect(b.handle.state).toBe('exited');

    const turn = textTurn(dslContext(), { prompt: null, text: 'abc' });
    const cut = createFakeBackend({ scenario: single('t', events(turn, closeGate()), { crashAfterSeq: 3 }) });
    const d = start(cut);
    await d.consumed;
    expect(messages(d.collected)).toHaveLength(3);
    expect(d.collected.at(-1)).toMatchObject({ type: 'exit', code: 1, expected: false });
  });

  it('abortDecision / abort event: the signal aborts, the player continues without waiting', async () => {
    const ctx = c();
    const ev = events(
      permissionStep(ctx, { toolName: 'Bash', input: {}, toolUseId: 'a1', parallel: true }),
      toEvents([['abort', { source: 'canUseTool.signal', toolUseID: 'a1' }]]),
      permissionStep(ctx, { toolName: 'Bash', input: {}, toolUseId: 'a2', decision: null }),
      closeGate(),
    );
    const signals = new Map<string, AbortSignal>();
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle } = start(backend, (req, signal) => {
      signals.set(req.toolUseId, signal);
      return new Promise(() => undefined);
    });
    await backend.settle();
    expect(signals.get('a1')?.aborted).toBe(true);
    expect(handle.state).toBe('waiting-decision');
    handle.abortDecision();
    expect(signals.get('a2')?.aborted).toBe(true);
    await backend.settle();
    expect(handle.state).toBe('waiting-close');
    await agent.close();
  });

  it('calls: last played answer, else the first of the file, else defaults; controls get their recorded answer', async () => {
    const ctx = c();
    const ev = events(
      input(ctx, 'u', 'x'),
      toEvents([
        [
          'call',
          {
            fn: 'getContextUsage',
            args: [{ detail: 'summary' }],
            result: { totalTokens: 2, maxTokens: 10 },
            ms: 1,
          },
        ],
        ['control', { method: 'setModel', args: ['haiku'], error: { message: 'model refused' }, ms: 1 }],
      ]),
    );
    const backend = createFakeBackend({ scenario: single('t', ev) });
    const { agent, handle } = start(backend);
    await backend.settle();
    // Not played yet: the first one of the file answers.
    await expect(agent.getContextUsage('summary')).resolves.toEqual({ totalTokens: 2, maxTokens: 10 });
    await expect(agent.supportedModels()).resolves.toHaveLength(5);
    await expect(agent.supportedCommands()).resolves.toContainEqual(
      expect.objectContaining({ name: 'clear' }),
    );
    await expect(agent.setModel('opus')).resolves.toBeUndefined();
    agent.send(prompt('x', 1));
    await backend.settle();
    await expect(agent.setModel('haiku')).rejects.toThrow('model refused');
    await agent.applyFlagSettings({ effortLevel: 'high' });
    await agent.stopTask('task_1');
    expect(handle.calls.map((c2) => c2.fn)).toEqual([
      'getContextUsage',
      'supportedModels',
      'supportedCommands',
    ]);
    expect(handle.controls.map((c2) => c2.method)).toEqual([
      'setModel',
      'setModel',
      'applyFlagSettings',
      'stopTask',
    ]);
    await agent.close();
    await expect(agent.getContextUsage('summary')).rejects.toThrow('session closed');
  });

  it('settle() resolves only when every live session waits at a gate', async () => {
    const backend = createFakeBackend({ scenario: single('t', events(input(dslContext(), 'u', 'x'))) });
    const one = start(backend);
    const two = start(backend);
    await backend.settle();
    expect([one.handle.state, two.handle.state]).toEqual(['waiting-input', 'waiting-input']);
    await backend.dispose();
    expect(backend.sessions.every((s) => s.state === 'exited')).toBe(true);
    expect(backend.starts).toHaveLength(2);
    expect(one.handle.pid).toBe(40_000);
    expect(two.handle.pid).toBe(40_001);
  });

  it('speed 1: delays follow the recorded tMs via the sleep seam, capped at maxDelayMs', async () => {
    const slept: number[] = [];
    const ev: FixtureEvent[] = [
      { seq: 1, tMs: 0, kind: 'mark', payload: {} },
      { seq: 2, tMs: 500, kind: 'mark', payload: {} },
      { seq: 3, tMs: 9500, kind: 'mark', payload: {} },
    ];
    const backend = createFakeBackend({
      scenario: single('t', ev),
      speed: 1,
      maxDelayMs: 3000,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    const { agent } = start(backend);
    await backend.settle();
    expect(slept).toEqual([500, 3000]);
    await agent.close();
  });
});

describe('FakeBackend â€“ history, info, rename', () => {
  it('readHistory/getSessionInfo map the FakeHistoryStore like the SdkBackend (seeded from history.jsonl)', async () => {
    const parsed = await loadFixtureScenario('history');
    const backend = createFakeBackend();
    backend.history.seedFromHistoryFixture(parsed);
    const sessionId = 'a0cb07c5-45cb-4164-b7d5-c808ecf195a6';
    const messagesOf = await backend.readHistory({ sessionId, cwd: 'D:\\w', launch });
    expect(messagesOf.length).toBeGreaterThan(5);
    expect(messagesOf.some((m) => m.parentToolUseId !== null)).toBe(true);
    expect(messagesOf.some((m) => m.origin?.kind === 'human')).toBe(true);
    await expect(backend.getSessionInfo({ sessionId, cwd: 'D:\\w', launch })).resolves.toMatchObject({
      sessionId,
      summary: 'Subagent ping spike',
      firstPrompt: expect.stringContaining('Use the Agent tool') as string,
    });
    // Only summary calls for this session â†’ no messages, but the info.
    const summaryOnly = 'a2aa36f5-56fb-42f9-af06-3db55a33470f';
    await expect(backend.readHistory({ sessionId: summaryOnly, cwd: 'D:\\w', launch })).resolves.toEqual([]);
    await expect(backend.getSessionInfo({ sessionId: 'unknown', cwd: 'D:\\w', launch })).resolves.toBeNull();
    await backend.renameSession({ sessionId, cwd: 'D:\\w', launch, title: 'Renamed' });
    await expect(backend.getSessionInfo({ sessionId, cwd: 'D:\\w', launch })).resolves.toMatchObject({
      summary: 'Renamed',
      customTitle: 'Renamed',
    });
  });

  it('played messages and prompts land in the history; renameSession on a running session â†’ diagnostic', async () => {
    const parsed = await loadFixtureScenario('auth-probe');
    const backend = createFakeBackend({ scenario: () => fixtureScenario(parsed) });
    const { agent, handle } = start(backend, fixtureDecisionResponder(parsed));
    agent.send(prompt('Reply with exactly: OK', 1));
    await backend.settle();
    const sessionId = handle.sessionId ?? '';
    const history = await backend.readHistory({ sessionId, cwd: 'D:\\w', launch });
    expect(history.map((m) => m.type)).toEqual(['user', 'assistant']);
    expect(history[0]).toMatchObject({ uuid: sampleUuid(1), origin: { kind: 'human' } });
    await expect(backend.getSessionInfo({ sessionId, cwd: 'D:\\w', launch })).resolves.toMatchObject({
      firstPrompt: 'Reply with exactly: OK',
      summary: 'Reply with exactly: OK',
    });
    await backend.renameSession({ sessionId, cwd: 'D:\\w', launch, title: 'x' });
    expect(handle.diagnostics.map((d) => d.kind)).toEqual(['rename-running']);
    await agent.close();
  });
});

describe('FakeBackend â€“ session typing', () => {
  it('start() is synchronous and returns an AgentSession', () => {
    const backend = createFakeBackend({ scenario: single('t', []) });
    const agent: AgentSession = backend.start(request(allowAll));
    expect(agent.entryId).toBe(SAMPLE_IDS.entry);
    expect(agent.pid).toBe(40_000);
    void agent.close();
  });

  it('keeps only the last keepSessions exited sessions and starts; the counter goes on (R2-12)', async () => {
    const backend = createFakeBackend({
      keepSessions: 2,
      scenario: (_req, n) => eventsScenario(`s${String(n)}`, []),
    });
    const live = start(backend);
    for (let i = 0; i < 4; i += 1) {
      const s = start(backend);
      await s.agent.close();
      await s.consumed;
    }
    const last = start(backend);
    expect(last.agent.pid).toBe(40_005);
    expect(last.handle.scenario).toBe('s5');
    // The live one stays, of the exited ones only the newest two, plus the new one.
    expect(backend.sessions.map((s) => s.scenario)).toEqual(['s0', 's3', 's4', 's5']);
    expect(backend.starts.length).toBeLessThanOrEqual(3);
    await live.agent.close();
    await last.agent.close();
  });
});
