/**
 * The interactive dev scenario through the REAL normalizer, driven like the engine would
 * (registerPrompt before send, startConversation after a reset): every keyword, decisions,
 * interrupt, priority now/next, control calls.
 */
import { describe, expect, it } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { sampleId, SAMPLE_IDS } from '@shared/samples';
import type { TranscriptItem } from '@shared/model';
import { sessionOpSchema, type SessionOp } from '@shared/protocol';
import { createLiveNormalizer } from '../../sessions/normalizer';
import { testContext } from '../../sessions/normalizer/testing/harness';
import type { StatusSignal } from '../../sessions/ports';
import type { BackendEvent, OutgoingPrompt, PermissionRequest, StartSessionRequest } from '../types';
import { createFakeBackend, sequentialIds } from '../fakeBackend';
import { realSetImmediate } from './common';
import { createFakeClaudeIntegration } from './integration';

const launch = await createFakeClaudeIntegration().launchSpecFor('standard', SAMPLE_IDS.entry);

async function until(predicate: () => boolean, what: string, limit = 20_000): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => {
      realSetImmediate(resolve);
    });
  }
  throw new Error(`timeout waiting for ${what}`);
}

interface Pending {
  req: PermissionRequest;
  signal: AbortSignal;
  resolve(result: PermissionResult): void;
}

function harness(p: Partial<StartSessionRequest> = {}) {
  const ids = sequentialIds();
  const backend = createFakeBackend({ ids });
  const pending: Pending[] = [];
  const agent = backend.start({
    entryId: SAMPLE_IDS.entry,
    cwd: 'D:\\work\\fake',
    launch,
    resumeSessionId: null,
    model: null,
    permissionMode: null,
    effort: null,
    promptSuggestions: false,
    canUseTool: (req, signal) =>
      new Promise((resolve) => {
        pending.push({ req, signal, resolve });
      }),
    ...p,
  });
  const handle = backend.sessions[0];
  if (handle === undefined) throw new Error('no handle');
  let conversations = 1;
  const normalizer = createLiveNormalizer(testContext(sampleId('cv', 1)));
  const ops: SessionOp[] = [];
  const signals: StatusSignal[] = [];
  const events: BackendEvent[] = [];
  const consumed = (async () => {
    for await (const event of agent.events) {
      events.push(event);
      if (event.type !== 'message') continue;
      const out = normalizer.push(event.message, event.at);
      for (const op of out.ops) expect(sessionOpSchema.parse(op)).toStrictEqual(op);
      ops.push(...out.ops);
      signals.push(...out.signals);
      for (const signal of out.signals) {
        if (signal.type === 'conversation_reset')
          normalizer.startConversation(sampleId('cv', (conversations += 1)), 1);
      }
    }
  })();
  let n = 0;
  const send = (text: string, priority: 'next' | 'now' = 'next'): OutgoingPrompt => {
    n += 1;
    const prompt: OutgoingPrompt = {
      uuid: `00000000-0000-4000-b000-${n.toString(16).padStart(12, '0')}`,
      content: [{ type: 'text', text }],
      priority,
    };
    normalizer.registerPrompt({ messageUuid: prompt.uuid, text, attachments: [], priority, at: new Date() });
    agent.send(prompt);
    return prompt;
  };
  const items = (): TranscriptItem[] => {
    const byId = new Map<string, TranscriptItem>();
    for (const op of ops) {
      if (op.op === 'item.upsert') byId.set(op.item.id, op.item);
      else if (op.op === 'item.remove') byId.delete(op.itemId);
      else if (op.op === 'conversation.reset') byId.clear();
    }
    return [...byId.values()].sort((a, b) => a.order - b.order);
  };
  const results = () =>
    signals.filter((s): s is Extract<StatusSignal, { type: 'turn_result' }> => s.type === 'turn_result');
  const idles = () => signals.filter((s) => s.type === 'session_state' && s.state === 'idle').length;
  const turnDone = async (count: number) => {
    await until(() => idles() >= count, `${String(count)} idle signals`);
    await backend.settle();
  };
  const decision = async (count = 1) => {
    await until(() => pending.length >= count, `${String(count)} decisions`);
    const next = pending.shift();
    if (next === undefined) throw new Error('no decision');
    return next;
  };
  const close = async () => {
    await agent.close();
    await consumed;
  };
  return {
    backend,
    agent,
    handle,
    send,
    items,
    signals,
    results,
    idles,
    turnDone,
    decision,
    pending,
    events,
    close,
  };
}

const allowOf = (p: Pending): PermissionResult => ({
  behavior: 'allow',
  updatedInput: p.req.input,
  decisionClassification: 'user_temporary',
});
const texts = (items: TranscriptItem[]) =>
  items.flatMap((i) => (i.kind === 'assistant_text' ? [i.text] : []));

describe('interactive scenario', () => {
  it('echo: thinking + streamed "Echo: …", result, idle; AI title after the first turn', async () => {
    const h = harness();
    await h.backend.settle();
    expect(h.handle.state).toBe('waiting-input');
    expect(h.events[0]).toMatchObject({ type: 'spawned', pid: 40_000 });
    h.send('hello there');
    await h.turnDone(1);
    const items = h.items();
    expect(items.map((i) => i.kind)).toEqual(['user_message', 'thinking', 'assistant_text', 'turn_result']);
    expect(texts(items)).toEqual(['Echo: hello there']);
    expect(h.results()[0]).toMatchObject({ outcome: 'success', synthetic: false });
    const sessionId = h.handle.sessionId ?? '';
    await expect(
      h.backend.getSessionInfo({ sessionId, cwd: 'D:\\work\\fake', launch }),
    ).resolves.toMatchObject({
      summary: 'Fake: hello there',
      firstPrompt: 'hello there',
    });
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('fake:bash – allow (suggestions as in permissions.jsonl), deny with message, deny+interrupt', async () => {
    const h = harness();
    h.send('fake:bash');
    const first = await h.decision();
    expect(first.req).toMatchObject({ toolName: 'Bash', decisionReasonType: 'other' });
    expect(first.req.suggestions.map((s) => s.type)).toEqual(['addRules', 'addDirectories', 'setMode']);
    first.resolve(allowOf(first));
    await h.turnDone(1);
    expect(h.items().find((i) => i.kind === 'tool_call')).toMatchObject({ toolName: 'Bash', status: 'done' });

    h.send('FAKE:BASH again');
    const second = await h.decision();
    second.resolve({ behavior: 'deny', message: 'not now', interrupt: false });
    await h.turnDone(2);
    expect(h.results()[1]).toMatchObject({ outcome: 'success' });
    expect(texts(h.items()).at(-1)).toBe('Okay, I did not run the command.');

    h.send('fake:permission');
    const third = await h.decision();
    third.resolve({ behavior: 'deny', message: 'The user interrupted.', interrupt: true });
    await h.turnDone(3);
    expect(h.results()[2]).toMatchObject({ outcome: 'interrupted' });
    expect(
      h
        .items()
        .filter((i) => i.kind === 'tool_call')
        .at(-1),
    ).toMatchObject({ status: 'interrupted' });
    await h.close();
  });

  it('fake:edit – Write with only setMode acceptEdits', async () => {
    const h = harness();
    h.send('fake:edit');
    const d = await h.decision();
    expect(d.req.suggestions).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
    d.resolve(allowOf(d));
    await h.turnDone(1);
    expect(h.items().find((i) => i.kind === 'tool_call')).toMatchObject({
      toolName: 'Write',
      status: 'done',
    });
    await h.close();
  });

  it('fake:question – two options with markdown previews, the answer is quoted', async () => {
    const h = harness();
    h.send('fake:question');
    const d = await h.decision();
    expect(d.req).toMatchObject({ toolName: 'AskUserQuestion', requiresUserInteraction: true });
    d.resolve({
      behavior: 'allow',
      updatedInput: {
        ...d.req.input,
        answers: { 'Which color should the button be?': 'Blue' },
        annotations: {},
      },
    });
    await h.turnDone(1);
    expect(texts(h.items()).at(-1)).toBe('You chose: Blue');
    await h.close();
  });

  it('fake:plan – plan file without card, revise → v2, approve with mode → status, IMPLEMENTED', async () => {
    const h = harness();
    h.send('fake:plan');
    const v1 = await h.decision();
    expect(v1.req.toolName).toBe('ExitPlanMode');
    v1.resolve({ behavior: 'deny', message: 'Also read the file back.' });
    const v2 = await h.decision();
    expect(String(v2.req.input.plan)).toContain('Revision 1');
    v2.resolve({
      behavior: 'allow',
      updatedInput: v2.req.input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    await h.turnDone(1);
    expect(h.signals).toContainEqual({ type: 'permission_mode', mode: 'acceptEdits' });
    expect(texts(h.items()).at(-1)).toBe('IMPLEMENTED');
    expect(h.items().filter((i) => i.kind === 'tool_call' && i.toolName === 'Write')).toHaveLength(3);
    await h.close();
  });

  it('fake:subagent – first result while the agent runs, idle only after the second turn (F.11)', async () => {
    const h = harness();
    h.send('fake:subagent');
    await h.turnDone(1);
    expect(h.results()).toHaveLength(2);
    expect(h.idles()).toBe(1);
    const order = h.signals.map((s) => s.type);
    expect(order.lastIndexOf('turn_result')).toBeLessThan(order.lastIndexOf('session_state'));
    expect(
      h
        .items()
        .filter((i) => i.parentToolUseId !== null)
        .map((i) => i.kind),
    ).toEqual(['thinking', 'assistant_text']);
    expect(texts(h.items()).at(-1)).toBe('SUBAGENT SAID PONG');
    await h.close();
  });

  it('fake:parallel – two subagents ask at the same time (several open decisions)', async () => {
    const h = harness();
    h.send('fake:parallel');
    await until(() => h.pending.length === 2, 'two open decisions');
    expect(h.pending.map((p) => p.req.agentId)).toEqual([
      expect.stringMatching(/^task_/),
      expect.stringMatching(/^task_/),
    ]);
    const [a, b] = [...h.pending];
    h.pending.length = 0;
    if (a === undefined || b === undefined) throw new Error('decisions');
    b.resolve(allowOf(b));
    a.resolve(allowOf(a));
    await h.turnDone(1);
    expect(texts(h.items()).at(-1)).toBe('Both workers are done.');
    await h.close();
  });

  it('fake:slow + interrupt() → aborted_streaming epilogue, idle, session usable', async () => {
    const h = harness();
    h.send('fake:slow');
    await until(() => h.signals.some((s) => s.type === 'context_estimate'), 'streaming started');
    await expect(h.agent.interrupt()).resolves.toEqual({ stillQueued: [] });
    await h.turnDone(1);
    expect(h.results()[0]).toMatchObject({ outcome: 'interrupted' });
    expect(h.items().some((i) => i.kind === 'system' && i.event === 'interrupted')).toBe(true);
    h.send('still there?');
    await h.turnDone(2);
    expect(texts(h.items()).at(-1)).toBe('Echo: still there?');
    // interrupt() while idle: no-op (F.10)
    await expect(h.agent.interrupt()).resolves.toEqual({ stillQueued: [] });
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it("priority 'now' aborts the running turn (aborted_tools, no idle) and starts a new one; 'next' is queued", async () => {
    const h = harness();
    h.send('fake:slow');
    await until(() => h.signals.some((s) => s.type === 'context_estimate'), 'streaming started');
    const next = h.send('queued later', 'next');
    await until(
      () =>
        h.signals.some(
          (s) => s.type === 'prompt_lifecycle' && s.messageUuid === next.uuid && s.state === 'queued',
        ),
      'queued',
    );
    const now = h.send('right now', 'now');
    await h.turnDone(2);
    expect(h.results().map((r) => r.outcome)).toEqual(['interrupted', 'success', 'success']);
    expect(texts(h.items()).slice(-2)).toEqual(['Echo: right now', 'Echo: queued later']);
    expect(
      h.signals
        .filter((s) => s.type === 'prompt_lifecycle' && s.messageUuid === now.uuid)
        .map((s) => (s.type === 'prompt_lifecycle' ? s.state : '')),
    ).toEqual(['queued', 'started', 'completed']);
    await h.close();
  });

  it('fake:compact, fake:ratelimit, fake:error', async () => {
    const h = harness();
    h.send('fake:compact');
    await h.turnDone(1);
    expect(
      h.signals
        .filter((s) => s.type === 'compacting')
        .map((s) => s.active),
    ).toEqual([true, false]);
    expect(h.items().some((i) => i.kind === 'system' && i.event === 'compact_boundary')).toBe(true);
    h.send('fake:ratelimit');
    await h.turnDone(2);
    expect(
      h.signals
        .filter((s) => s.type === 'rate_limit')
        .map((s) => s.info.status),
    ).toEqual(['allowed_warning', 'rejected']);
    h.send('fake:error');
    await h.turnDone(3);
    expect(
      h.signals.find((s) => s.type === 'assistant_error' && s.error.code === 'CLAUDE_AUTH_FAILED'),
    ).toBeDefined();
    await h.close();
  });

  it('fake:crash → partial stream, exit code 1; fake:held → SESSION_HELD_ELSEWHERE, exit 1', async () => {
    const crash = harness();
    crash.send('fake:crash');
    await until(() => crash.handle.state === 'exited', 'exit');
    await crash.close();
    expect(crash.events.at(-1)).toMatchObject({ type: 'exit', code: 1, expected: false });

    const held = harness();
    held.send('fake:held');
    await until(() => held.handle.state === 'exited', 'exit');
    await held.close();
    expect(held.results()[0]).toMatchObject({
      startupFailure: true,
      error: { code: 'SESSION_HELD_ELSEWHERE' },
    });
    expect(held.events.at(-1)).toMatchObject({ type: 'exit', code: 1, expected: false });
  });

  it('/rename X and /clear (new session id from the next init, custom title kept)', async () => {
    const h = harness();
    h.send('hello');
    await h.turnDone(1);
    const first = h.handle.sessionId ?? '';
    h.send('/rename My Title');
    await h.turnDone(2);
    expect(h.signals).toContainEqual({ type: 'title_changed', title: 'My Title' });
    h.send('/clear');
    await h.turnDone(3);
    const reset = h.signals.find((s) => s.type === 'conversation_reset');
    expect(reset).toMatchObject({ trigger: 'clear' });
    const second = h.handle.sessionId ?? '';
    expect(second).not.toBe(first);
    expect(
      h.signals
        .filter((s) => s.type === 'session_id')
        .map((s) => s.sessionId),
    ).toEqual([first, second]);
    await expect(
      h.backend.getSessionInfo({ sessionId: second, cwd: 'D:\\w', launch }),
    ).resolves.toMatchObject({ customTitle: 'My Title' });
    expect(h.results().filter((r) => r.synthetic)).toHaveLength(2);
    await h.close();
  });

  it('control calls change the state: setModel → init.model, setPermissionMode in a turn → system/status; context grows', async () => {
    const h = harness({ resumeSessionId: '5e550000-0000-4000-8000-0000000000cc', permissionMode: 'plan' });
    await h.agent.setModel('sonnet');
    h.send('one');
    await h.turnDone(1);
    expect(h.signals.find((s) => s.type === 'init')).toMatchObject({
      model: 'claude-sonnet-5-5',
      permissionMode: 'plan',
      sessionId: '5e550000-0000-4000-8000-0000000000cc',
    });
    const before = await h.agent.getContextUsage('summary');
    const estimates = () => h.signals.filter((s) => s.type === 'context_estimate').length;
    const seen = estimates();
    h.send('fake:slow');
    await until(() => estimates() > seen, 'second turn streams');
    await h.agent.setPermissionMode('acceptEdits');
    expect(h.signals).toContainEqual({ type: 'permission_mode', mode: 'acceptEdits' });
    await h.agent.interrupt();
    await h.turnDone(2);
    const after = await h.agent.getContextUsage('summary');
    expect((after as { totalTokens: number }).totalTokens).toBeGreaterThan(
      (before as { totalTokens: number }).totalTokens,
    );
    await expect(h.agent.supportedModels()).resolves.toHaveLength(5);
    expect(h.handle.controls.map((c) => c.method)).toEqual(['setModel', 'setPermissionMode', 'interrupt']);
    await h.close();
  });
});
