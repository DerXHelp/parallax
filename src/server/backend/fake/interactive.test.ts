/**
 * The interactive dev scenario through the REAL normalizer, driven like the engine would
 * (registerPrompt before send, startConversation after a reset): every keyword, decisions,
 * interrupt, priority now/next, control calls; Phase 2 (WP-34): images in a prompt, `fake:image`,
 * the 60-s rate limit, simulated console turns; Phase 3 (WP-52): `fake:background` + stopTask,
 * `fake:todo`, `fake:files`, `fake:writes-lost`, attachments/pastes, the fresh-context start.
 * Real fake files go to a temp root of this test file (removed afterwards).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { sampleId, SAMPLE_IDS } from '@shared/samples';
import type { TranscriptItem } from '@shared/model';
import { sessionOpSchema, type SessionOp } from '@shared/protocol';
import { realSetImmediate } from '../../lib/async';
import { createLiveNormalizer } from '../../sessions/normalizer';
import { testContext } from '../../sessions/normalizer/testing/harness';
import type { StatusSignal } from '../../sessions/ports';
import { sniffImageType } from '../../lib/images';
import { normalizeHistory } from '../../sessions/normalizer';
import type {
  BackendEvent,
  OutgoingContent,
  OutgoingPrompt,
  PermissionRequest,
  StartSessionRequest,
} from '../types';
import { createFakeBackend, sequentialIds, type FakeBackendOptions } from '../fakeBackend';
import { FAKE_CONSOLE_PROMPT, fakeConsoleAnswer } from './console';
import { FAKE_CONTEXT_HIGH_TOKENS, FAKE_MODELS } from './defaults';
import { FAKE_SHOT_HEIGHT, FAKE_SHOT_PNG_BASE64, FAKE_SHOT_WIDTH } from './image';
import { FAKE_RATE_LIMIT_RESET_S } from './interactive';
import { createFakeClaudeIntegration } from './integration';
import {
  FAKE_BACKGROUND_DONE,
  FAKE_BACKGROUND_MS,
  FAKE_BACKGROUND_STARTED,
  FAKE_BACKGROUND_SUMMARY,
  FAKE_CONTEXT_HIGH_TEXT,
  FAKE_UNC_PATH,
  FAKE_WRITES_LOST_TEXT,
} from './phase3';
import { FAKE_PLAN_INPUT_CHUNKS } from './plan';

const launch = await createFakeClaudeIntegration().launchSpecFor('standard', SAMPLE_IDS.entry);

/** Real fake files of this test file: one temp root, a fresh sub folder per harness. */
const filesRoot = mkdtempSync(path.join(os.tmpdir(), 'parallax-fake-files-test-'));
afterAll(() => {
  rmSync(filesRoot, { recursive: true, force: true });
});

/**
 * Wall-clock limit of `until` (V4-02, docs/wp/FLAKES.md "Wanduhr-Annahme"): `fake:files` does real
 * file I/O, which under parallel load outlasted a fixed number of event-loop rounds. Below the
 * node project's 20-s test timeout, so a missing event still fails with this message.
 */
const UNTIL_TIMEOUT_MS = 10_000;

/** The web's mark of the "fresh context" recommendation (decisions/lib/plan.ts, ADR-147). */
const FRESH_CONTEXT_PERCENT = 60;

async function until(predicate: () => boolean, what: string, timeoutMs = UNTIL_TIMEOUT_MS): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (performance.now() > deadline) throw new Error(`timeout waiting for ${what} (${String(timeoutMs)} ms)`);
    await new Promise((resolve) => {
      realSetImmediate(resolve);
    });
  }
}

interface Pending {
  req: PermissionRequest;
  signal: AbortSignal;
  resolve(result: PermissionResult): void;
}

function harness(p: Partial<StartSessionRequest> = {}, options: Partial<FakeBackendOptions> = {}) {
  const ids = sequentialIds();
  const root = mkdtempSync(path.join(filesRoot, 'h-'));
  const backend = createFakeBackend({ ids, filesRoot: root, ...options });
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
  const send = (
    text: string,
    priority: 'next' | 'now' = 'next',
    blocks: readonly OutgoingContent[] = [],
    inlinePastes: readonly string[] = [],
  ): OutgoingPrompt => {
    n += 1;
    const prompt: OutgoingPrompt = {
      uuid: `00000000-0000-4000-b000-${n.toString(16).padStart(12, '0')}`,
      content: [...blocks, ...(text === '' ? [] : [{ type: 'text' as const, text }])],
      priority,
      ...(inlinePastes.length === 0 ? {} : { inlinePastes: [...inlinePastes] }),
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
    root,
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

const streamEventSchema = z.looseObject({
  type: z.literal('stream_event'),
  event: z.looseObject({
    type: z.string(),
    content_block: z.looseObject({ type: z.string(), name: z.string().optional() }).optional(),
    delta: z.looseObject({ type: z.string() }).optional(),
  }),
});

/** input_json_delta parts per streamed `Write` tool_use block, in order. */
function writeInputDeltas(events: readonly BackendEvent[]): number[] {
  const counts: number[] = [];
  let open = false;
  for (const event of events) {
    if (event.type !== 'message') continue;
    const parsed = streamEventSchema.safeParse(event.message);
    if (!parsed.success) continue;
    const e = parsed.data.event;
    if (e.type === 'content_block_start') {
      open = e.content_block?.type === 'tool_use' && e.content_block.name === 'Write';
      if (open) counts.push(0);
    } else if (e.type === 'content_block_delta' && open && e.delta?.type === 'input_json_delta') {
      counts[counts.length - 1] = (counts.at(-1) ?? 0) + 1;
    } else if (e.type === 'content_block_stop') {
      open = false;
    }
  }
  return counts;
}

/** A controllable clock for speed 1: the background task's long waits block until released. */
function manualSleep() {
  const pending: { ms: number; resolve: () => void }[] = [];
  return {
    pending,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        if (ms >= FAKE_BACKGROUND_MS / 2) pending.push({ ms, resolve });
        else realSetImmediate(resolve);
      }),
    release() {
      const next = pending.shift();
      if (next === undefined) throw new Error('nothing sleeps');
      next.resolve();
    },
  };
}

function agentCall(items: TranscriptItem[]) {
  const call = items.find((i) => i.kind === 'tool_call' && i.toolName === 'Agent');
  if (call?.kind !== 'tool_call') throw new Error('no Agent call');
  return call;
}

describe('until (test helper, V4-02)', () => {
  it('waits by wall clock, not by event-loop rounds: slow I/O (a 1.5-s timer) still arrives', async () => {
    let done = false;
    setTimeout(() => {
      done = true;
    }, 1_500);
    await until(() => done, 'the slow timer');
    expect(done).toBe(true);
  });

  it('gives up after its wall-clock limit with the reason', async () => {
    const started = performance.now();
    await expect(until(() => false, 'nothing', 50)).rejects.toThrow('timeout waiting for nothing (50 ms)');
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });
});

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

  it('fake:plan – plan mode, plan file streamed and written for real, revise → v2 in the same file, approve with mode → status, IMPLEMENTED', async () => {
    const h = harness();
    h.send('fake:plan');
    const v1 = await h.decision();
    expect(v1.req.toolName).toBe('ExitPlanMode');
    // Phase 3 (WP-52): the mode switches to plan in the turn; the plan file is real.
    expect(h.signals).toContainEqual({ type: 'permission_mode', mode: 'plan' });
    const sessionId = h.handle.sessionId ?? '';
    const planFile = path.join(h.root, sessionId, 'plans', 'fake-plan.md');
    expect(v1.req.input.planFilePath).toBe(planFile);
    expect(readFileSync(planFile, 'utf8')).toBe(v1.req.input.plan);
    expect(writeInputDeltas(h.events)[0]).toBeGreaterThanOrEqual(5);
    expect(writeInputDeltas(h.events)[0]).toBe(FAKE_PLAN_INPUT_CHUNKS);
    v1.resolve({ behavior: 'deny', message: 'Also read the file back.' });
    const v2 = await h.decision();
    expect(String(v2.req.input.plan)).toContain('Revision 1');
    expect(v2.req.input.planFilePath).toBe(planFile);
    expect(readFileSync(planFile, 'utf8')).toBe(v2.req.input.plan);
    v2.resolve({
      behavior: 'allow',
      updatedInput: v2.req.input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    await h.turnDone(1);
    expect(h.signals).toContainEqual({ type: 'permission_mode', mode: 'acceptEdits' });
    expect(texts(h.items()).at(-1)).toBe('IMPLEMENTED');
    const writes = h.items().filter((i) => i.kind === 'tool_call' && i.toolName === 'Write');
    expect(writes).toHaveLength(3);
    expect(writes.map((w) => (w.kind === 'tool_call' ? w.result?.structured : null))).toMatchObject([
      { type: 'create', filePath: planFile },
      { type: 'update', filePath: planFile },
      null,
    ]);
    // The implementation's hello.txt stays transcript-only: nothing lands in the project.
    expect(existsSync(path.join('D:\\work\\fake', 'hello.txt'))).toBe(false);
    expect(h.handle.diagnostics).toEqual([]);
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
    expect(h.signals.filter((s) => s.type === 'compacting').map((s) => s.active)).toEqual([true, false]);
    expect(h.items().some((i) => i.kind === 'system' && i.event === 'compact_boundary')).toBe(true);
    h.send('fake:ratelimit');
    await h.turnDone(2);
    expect(h.signals.filter((s) => s.type === 'rate_limit').map((s) => s.info.status)).toEqual([
      'allowed_warning',
      'rejected',
    ]);
    // WP-34 (d): the window resets ≈ 60 s from now (E2E "continue at" within a test run).
    const rejected = h.signals.find((s) => s.type === 'rate_limit' && s.info.status === 'rejected');
    const resetsAt = rejected?.type === 'rate_limit' ? Date.parse(rejected.info.resetsAt ?? '') : Number.NaN;
    expect(resetsAt - Date.now()).toBeGreaterThan((FAKE_RATE_LIMIT_RESET_S - 15) * 1000);
    expect(resetsAt - Date.now()).toBeLessThanOrEqual(FAKE_RATE_LIMIT_RESET_S * 1000);
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
    expect(h.signals.filter((s) => s.type === 'session_id').map((s) => s.sessionId)).toEqual([first, second]);
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
    await expect(h.agent.supportedModels()).resolves.toHaveLength(FAKE_MODELS.length);
    expect(h.handle.controls.map((c) => c.method)).toEqual(['setModel', 'setPermissionMode', 'interrupt']);
    await h.close();
  });
});

describe('interactive scenario – Phase 2 (WP-34)', () => {
  const png: OutgoingContent = { type: 'image', mediaType: 'image/png', base64: FAKE_SHOT_PNG_BASE64 };

  it('(a) a prompt with images → "Fake: received N image(s)"; the images reach the history as blocks', async () => {
    const h = harness();
    h.send('What do you see?', 'next', [png, png]);
    await h.turnDone(1);
    expect(texts(h.items())).toEqual(['Fake: received 2 image(s)']);
    h.send('', 'next', [png]);
    await h.turnDone(2);
    expect(texts(h.items()).at(-1)).toBe('Fake: received 1 image(s)');
    const sessionId = h.handle.sessionId ?? '';
    const history = await h.backend.readHistory({ sessionId, cwd: 'D:\\work\\fake', launch });
    const first = history.find((m) => m.type === 'user');
    expect(first?.message).toMatchObject({
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        { type: 'text', text: 'What do you see?' },
      ],
    });
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('(b) fake:image → Read of fake-shot.png with an image result: a small, complete PNG as blob', async () => {
    const h = harness();
    h.send('fake:image');
    await h.turnDone(1);
    const call = h.items().find((i) => i.kind === 'tool_call');
    if (call?.kind !== 'tool_call') throw new Error('no tool call');
    expect(call).toMatchObject({
      toolName: 'Read',
      status: 'done',
      input: { file_path: expect.stringMatching(/\\fake-shot\.png$/) as string },
    });
    const image = call.result?.content.find((part) => part.type === 'image');
    expect(image).toMatchObject({ type: 'image', image: { mediaType: 'image/png' } });
    expect(texts(h.items()).at(-1)).toBe('The screenshot shows a window with an orange block.');

    // ≤ 1 KB, valid: signature, IHDR 24×16, every chunk CRC, IDAT inflates to the raw rows.
    const bytes = Buffer.from(FAKE_SHOT_PNG_BASE64, 'base64');
    expect(bytes.byteLength).toBeLessThanOrEqual(1024);
    expect(sniffImageType(bytes)).toBe('image/png');
    const chunks: { type: string; data: Buffer }[] = [];
    for (let at = 8; at < bytes.byteLength;) {
      const length = bytes.readUInt32BE(at);
      const type = bytes.toString('ascii', at + 4, at + 8);
      const data = bytes.subarray(at + 8, at + 8 + length);
      expect(bytes.readUInt32BE(at + 8 + length)).toBe(crc32(bytes.subarray(at + 4, at + 8 + length)));
      chunks.push({ type, data });
      at += 12 + length;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0]?.data ?? Buffer.alloc(0);
    expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)]).toEqual([FAKE_SHOT_WIDTH, FAKE_SHOT_HEIGHT]);
    expect(inflateSync(chunks[1]?.data ?? Buffer.alloc(0)).byteLength).toBe(
      FAKE_SHOT_HEIGHT * (1 + FAKE_SHOT_WIDTH * 3),
    );
    await h.close();
  });

  it('(c) simulateConsoleTurn → a user and an assistant entry with the given time in the history', async () => {
    const h = harness();
    h.send('hello');
    await h.turnDone(1);
    const sessionId = h.handle.sessionId ?? '';
    const at = new Date('2026-10-15T09:30:00.000Z');
    h.backend.simulateConsoleTurn(sessionId, at);
    h.backend.simulateConsoleTurn(sessionId, at, 'second console prompt');
    const history = await h.backend.readHistory({ sessionId, cwd: 'D:\\work\\fake', launch });
    const consoleMessages = history.filter((m) => m.timestamp === at.toISOString());
    expect(consoleMessages.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const { items } = normalizeHistory(consoleMessages, {
      entryId: SAMPLE_IDS.entry,
      conversationId: sampleId('cv', 1),
      nextOrder: 10,
      storeBlob: () => {
        throw new Error('no blobs');
      },
      now: () => at,
    });
    expect(items.map((i) => [i.kind, i.order, i.at])).toEqual([
      ['user_message', 10, at.toISOString()],
      ['assistant_text', 11, at.toISOString()],
      ['user_message', 12, at.toISOString()],
      ['assistant_text', 13, at.toISOString()],
    ]);
    expect(items.flatMap((i) => (i.kind === 'assistant_text' ? [i.text] : []))).toEqual([
      fakeConsoleAnswer(FAKE_CONSOLE_PROMPT),
      fakeConsoleAnswer('second console prompt'),
    ]);
    await h.close();
  });
});

describe('interactive scenario – Phase 3 (WP-52)', () => {
  const png: OutgoingContent = { type: 'image', mediaType: 'image/png', base64: FAKE_SHOT_PNG_BASE64 };
  const pdf: OutgoingContent = { type: 'document', mediaType: 'application/pdf', base64: 'JVBERi0xLjQK' };

  it('fake:background – run_in_background agent, summaries, real output file; idle held until the notification after 30 s', async () => {
    const clock = manualSleep();
    const h = harness({}, { speed: 1, sleep: clock.sleep });
    h.send('fake:background');
    await until(() => h.results().length === 1 && clock.pending.length === 1, 'launch result, first wait');
    expect(clock.pending.map((p) => p.ms)).toEqual([FAKE_BACKGROUND_MS / 2]);
    expect(texts(h.items()).at(-1)).toBe(FAKE_BACKGROUND_STARTED);
    const launched = agentCall(h.items());
    expect(launched.input).toMatchObject({ run_in_background: true });
    const sessionId = h.handle.sessionId ?? '';
    const taskId = launched.task?.taskId ?? '';
    const outputFile = path.join(h.root, sessionId, 'tasks', `${taskId}.output`);
    expect(launched.task).toMatchObject({
      isBackgrounded: true,
      summary: 'Reading the project files',
      outputFile,
    });
    expect(readFileSync(outputFile, 'utf8')).toContain('started');
    // The CLI holds idle back while a background agent runs (SDKSessionStateChangedMessage).
    expect(h.idles()).toBe(0);

    clock.release();
    await until(() => agentCall(h.items()).task?.summary === 'Writing the summary', 'second summary');
    await until(() => clock.pending.length === 1, 'second wait');
    expect(h.idles()).toBe(0);
    clock.release();
    await h.turnDone(1);
    expect(agentCall(h.items()).task).toMatchObject({
      status: 'completed',
      summary: FAKE_BACKGROUND_SUMMARY,
      outputFile,
    });
    expect(readFileSync(outputFile, 'utf8')).toContain(FAKE_BACKGROUND_SUMMARY);
    // WP-60: a real end time (the task panel lists finished tasks for 10 minutes after it).
    expect(Date.now() - Date.parse(agentCall(h.items()).task?.endedAt ?? '')).toBeLessThan(60_000);
    // The follow-up turn answers the notification (F.11), then idle.
    expect(h.results()).toHaveLength(2);
    expect(texts(h.items()).at(-1)).toBe(FAKE_BACKGROUND_DONE);
    expect(
      h.signals.filter((s) => s.type === 'background_tasks').map((s) => s.count),
    ).toEqual([1, 0]);
    await expect(h.agent.stopTask(taskId)).rejects.toThrow(`Task ${taskId} is not running (status: completed)`);
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('stopTask: running agent → task_notification stopped and idle; again → not running; unknown → No task found', async () => {
    const clock = manualSleep();
    const h = harness({}, { speed: 1, sleep: clock.sleep });
    await expect(h.agent.stopTask('task_nope')).rejects.toThrow('No task found with ID: task_nope');
    h.send('fake:background');
    await until(() => h.results().length === 1 && clock.pending.length === 1, 'launch result, first wait');
    const taskId = agentCall(h.items()).task?.taskId ?? '';
    await h.agent.stopTask(taskId);
    await h.turnDone(1);
    expect(agentCall(h.items()).task).toMatchObject({ status: 'stopped', outputFile: expect.stringMatching(/\.output$/) as string });
    // WP-60: a real end time (the task panel lists finished tasks for 10 minutes after it).
    expect(Date.now() - Date.parse(agentCall(h.items()).task?.endedAt ?? '')).toBeLessThan(60_000);
    expect(h.results()).toHaveLength(1);
    await expect(h.agent.stopTask(taskId)).rejects.toThrow(`Task ${taskId} is not running (status: killed)`);
    expect(h.handle.controls.map((c) => [c.method, c.args])).toEqual([
      ['stopTask', ['task_nope']],
      ['stopTask', [taskId]],
      ['stopTask', [taskId]],
    ]);
    // The stopped task's wait ends quietly; the session stays usable.
    clock.release();
    h.send('still there?');
    await h.turnDone(2);
    expect(texts(h.items()).at(-1)).toBe('Echo: still there?');
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('fake:background at speed 0: the agent starts after the launch turn, one idle after the follow-up turn', async () => {
    const h = harness();
    h.send('fake:background');
    await h.turnDone(1);
    expect(h.idles()).toBe(1);
    expect(h.results()).toHaveLength(2);
    const order = h.signals.map((s) => s.type);
    expect(order.indexOf('turn_result')).toBeLessThan(order.lastIndexOf('background_tasks'));
    expect(agentCall(h.items()).task).toMatchObject({ status: 'completed' });
    await h.close();
  });

  it('fake:todo – TodoWrite with three items, then in_progress, then completed', async () => {
    const h = harness();
    h.send('fake:todo');
    await h.turnDone(1);
    const calls = h.items().filter((i) => i.kind === 'tool_call' && i.toolName === 'TodoWrite');
    expect(calls).toHaveLength(3);
    const statuses = (s: string[]) => ({ input: { todos: s.map((status) => ({ status })) }, status: 'done' });
    expect(calls).toMatchObject([
      statuses(['pending', 'pending', 'pending']),
      statuses(['in_progress', 'pending', 'pending']),
      statuses(['completed', 'pending', 'pending']),
    ]);
    expect(texts(h.items()).at(-1)).toBe('The first item is done; two are left.');
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('fake:context-high – the context stays at 75 % (getContextUsage and streamed usage) until a compaction or /clear (V4-05)', async () => {
    const h = harness();
    const percentage = async () =>
      z.looseObject({ percentage: z.number() }).parse(await h.agent.getContextUsage('summary')).percentage;
    const estimates = () => h.signals.flatMap((s) => (s.type === 'context_estimate' ? [s.totalTokens] : []));
    h.send('hello');
    await h.turnDone(1);
    expect(await percentage()).toBeLessThan(FRESH_CONTEXT_PERCENT);
    expect(estimates().at(-1)).toBeLessThan(FAKE_CONTEXT_HIGH_TOKENS / 2);

    h.send('fake:context-high');
    await h.turnDone(2);
    expect(texts(h.items()).at(-1)).toBe(FAKE_CONTEXT_HIGH_TEXT);
    expect(await percentage()).toBe(75);
    expect(estimates().at(-1)).toBe(FAKE_CONTEXT_HIGH_TOKENS);
    // Later turns (here a tool turn) keep streaming the high usage; the answer stays at 75 %.
    const seen = estimates().length;
    h.send('fake:todo');
    await h.turnDone(3);
    expect(estimates().slice(seen).every((total) => total === FAKE_CONTEXT_HIGH_TOKENS)).toBe(true);
    expect(await percentage()).toBe(75);

    h.send('fake:compact');
    await h.turnDone(4);
    expect(await percentage()).toBeLessThan(FRESH_CONTEXT_PERCENT);
    h.send('fake:context-high');
    await h.turnDone(5);
    expect(await percentage()).toBe(75);
    h.send('/clear');
    await h.turnDone(6);
    expect(await percentage()).toBeLessThan(FRESH_CONTEXT_PERCENT);
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('fake:files – Read/Write/Edit on real files under the fake root, answer with file references', async () => {
    const h = harness();
    h.send('fake:files');
    await h.turnDone(1);
    const dir = path.join(h.root, h.handle.sessionId ?? '', 'files');
    const calls = h.items().flatMap((i) => (i.kind === 'tool_call' ? [i] : []));
    const filePath = (value: unknown) => z.looseObject({ file_path: z.string() }).parse(value).file_path;
    expect(calls.map((c) => [c.toolName, c.status, filePath(c.input)])).toEqual([
      ['Read', 'done', path.join(dir, 'notes.md')],
      ['Write', 'done', path.join(dir, 'new-file.txt')],
      ['Edit', 'done', path.join(dir, 'app.ts')],
    ]);
    expect(readFileSync(path.join(dir, 'notes.md'), 'utf8')).toContain('# Fake notes');
    expect(readFileSync(path.join(dir, 'new-file.txt'), 'utf8')).toBe('Created by fake:files.\n');
    expect(readFileSync(path.join(dir, 'app.ts'), 'utf8').split('\n')[11]).toBe('  const answer = 42;');
    expect(calls[2]?.result?.structured).toMatchObject({
      structuredPatch: [expect.objectContaining({ lines: expect.arrayContaining(['-  const answer = 41;', '+  const answer = 42;']) as string[] })],
    });
    const answer = texts(h.items()).at(-1) ?? '';
    expect(answer).toContain(`${path.join(dir, 'app.ts')}:12`);
    expect(answer).toContain('README.md');
    expect(answer).toContain(`[notes.md](<${path.join(dir, 'notes.md').replaceAll('\\', '/')}>)`);
    expect(answer).toContain(FAKE_UNC_PATH);
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('fake:writes-lost – on close: system/session_writes_lost → error item SESSION_WRITES_LOST, exit 0', async () => {
    const h = harness();
    h.send('fake:writes-lost');
    await h.turnDone(1);
    expect(texts(h.items()).at(-1)).toBe(FAKE_WRITES_LOST_TEXT);
    expect(h.items().some((i) => i.kind === 'system' && i.event === 'error')).toBe(false);
    await h.close();
    expect(h.items().find((i) => i.kind === 'system' && i.event === 'error')).toMatchObject({
      error: { code: 'SESSION_WRITES_LOST', params: { lost: 'transcript', errorCode: 'ENOSPC' } },
    });
    expect(h.events.at(-1)).toMatchObject({ type: 'exit', code: 0, expected: true });
  });

  it('attachments: PDFs, an `Attached files:` block, inline pastes and images are counted', async () => {
    const h = harness();
    h.send('Look at these\n\nAttached files:\n- D:\\work\\a.txt\n- D:\\work\\b.log', 'next', [pdf], ['one', 'two', 'three']);
    await h.turnDone(1);
    expect(texts(h.items())).toEqual(['Fake: received 1 document(s), 2 file(s)\nFake: received 3 paste(s)']);
    h.send('', 'next', [png, pdf]);
    await h.turnDone(2);
    expect(texts(h.items()).at(-1)).toBe('Fake: received 1 image(s)\nFake: received 1 document(s), 0 file(s)');
    h.send('Attached files:\n- D:\\work\\only.txt');
    await h.turnDone(3);
    expect(texts(h.items()).at(-1)).toBe('Fake: received 0 document(s), 1 file(s)');
    const history = await h.backend.readHistory({ sessionId: h.handle.sessionId ?? '', cwd: 'D:\\work\\fake', launch });
    expect(history.find((m) => m.type === 'user')?.message).toMatchObject({
      content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } }, { type: 'text' }],
    });
    expect(h.handle.diagnostics).toEqual([]);
    await h.close();
  });

  it('fresh-context start: first prompt "Implement the following approved plan." without resume → plan lines; init mode = start mode', async () => {
    const plan = 'Implement the following approved plan.\nPlan file: C:\\Users\\u\\.claude\\plans\\p.md\n\n## Plan\n- one\n- two\n';
    const h = harness({ permissionMode: 'acceptEdits' });
    h.send(plan);
    await h.turnDone(1);
    expect(texts(h.items())).toEqual(['Fake: implementing plan (3 lines)']);
    expect(h.signals.find((s) => s.type === 'init')).toMatchObject({ permissionMode: 'acceptEdits' });
    h.send(plan);
    await h.turnDone(2);
    expect(texts(h.items()).at(-1)).not.toContain('implementing plan');
    await h.close();

    const resumed = harness({ resumeSessionId: '5e550000-0000-4000-8000-0000000000cd' });
    resumed.send(plan);
    await resumed.turnDone(1);
    expect(texts(resumed.items()).at(-1)).not.toContain('implementing plan');
    await resumed.close();
  });
});

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
