/**
 * DSL building blocks: fixture format v1 (fixtureEventSchema, parseFixture) and the REAL
 * normalizer (WP-12 harness) – the same item kinds as the corresponding recorded fixture.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/model';
import { sessionOpSchema } from '@shared/protocol';
import { FIXTURE_VERSION, fixtureEventSchema, parseFixture, type FixtureEvent } from '../fixture';
import {
  finalItems,
  loadAllFixtures,
  replayLive,
  signalList,
} from '../../sessions/normalizer/testing/harness';
import {
  assistantErrorTurn,
  clearCommand,
  closeGate,
  crash,
  dslContext,
  events,
  input,
  interruptEpilogue,
  permissionStep,
  planStep,
  questionStep,
  renameCommand,
  startupFailure,
  streamedText,
  subagentRun,
  textTurn,
  thinkingBlock,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
} from './dsl';

const fixtures = await loadAllFixtures();

function kind(item: TranscriptItem): string {
  return item.kind === 'system' ? `system/${item.event}` : item.kind;
}

function replay(ev: FixtureEvent[]) {
  const r = replayLive({ events: ev });
  for (const op of r.steps.flatMap((s) => s.ops)) expect(sessionOpSchema.parse(op)).toStrictEqual(op);
  const items = Object.values(finalItems(r)).flat();
  return { r, items, kinds: new Set(items.map(kind)) };
}

function fixtureKinds(name: string): Set<string> {
  const fixture = fixtures.get(name);
  if (fixture === undefined) throw new Error(`fixture ${name} missing`);
  return new Set(
    Object.values(finalItems(replayLive(fixture)))
      .flat()
      .map(kind),
  );
}

function valid(ev: FixtureEvent[]): void {
  for (const event of ev) expect(fixtureEventSchema.safeParse(event).success).toBe(true);
  expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
  for (let i = 1; i < ev.length; i += 1) expect(ev[i]?.tMs).toBeGreaterThanOrEqual(ev[i - 1]?.tMs ?? 0);
  const header = {
    fixtureVersion: FIXTURE_VERSION,
    scenario: 'dsl',
    sdkVersion: '0.3.296',
    cliVersion: '2.1.300',
    recordedAt: '2026-10-15T08:00:00.000Z',
    options: { synthetic: true },
  };
  const text = [header, ...ev].map((line) => JSON.stringify(line)).join('\n');
  expect(parseFixture(text, 'dsl').events).toHaveLength(ev.length);
}

const subset = (a: Set<string>, b: Set<string>) => [...a].filter((k) => !b.has(k));

describe('DSL building blocks', () => {
  it('textTurn = auth-probe kinds (user_message, thinking/text, turn_result), signals in order', () => {
    const c = dslContext();
    const prompt = c.ids.uuid();
    const ev = events(input(c, prompt, 'Hi'), textTurn(c, { prompt, text: 'OK', thinking: 'short' }));
    valid(ev);
    const { r, items, kinds } = replay(ev);
    expect(kinds).toEqual(new Set(['user_message', 'thinking', 'assistant_text', 'turn_result']));
    expect(
      subset(new Set(['user_message', 'assistant_text', 'turn_result']), fixtureKinds('auth-probe')),
    ).toEqual([]);
    expect(items.find((i) => i.kind === 'assistant_text')).toMatchObject({ text: 'OK', streaming: false });
    const types = signalList(r).map((s) => s.type);
    expect(types.indexOf('turn_result')).toBeLessThan(types.lastIndexOf('session_state'));
    expect(
      signalList(r)
        .filter((s) => s.type === 'prompt_lifecycle')
        .map((s) => s.state),
    ).toEqual(['queued', 'started', 'completed']);
  });

  it('streamedText / thinkingBlock / toolUseBlock stream with deltas and end final', () => {
    const c = dslContext();
    const ev = events(
      turnOpen(c, null),
      thinkingBlock(c, 'pondering'),
      streamedText(c, 'Hello world, this is streamed.', { chunks: 5 }),
      toolUseBlock(c, 'Read', { file_path: 'D:\\x.txt' }, { toolUseId: 'toolu_r' }),
      toolResultMessage(c, 'toolu_r', 'content', {
        toolUseResult: { type: 'text', file: { filePath: 'D:\\x.txt', content: 'content' } },
      }),
      turnClose(c, null),
    );
    valid(ev);
    const { r, items } = replay(ev);
    expect(r.steps.flatMap((s) => s.ops).filter((op) => op.op === 'item.delta').length).toBeGreaterThan(5);
    expect(items.find((i) => i.kind === 'tool_call')).toMatchObject({
      toolName: 'Read',
      status: 'done',
      input: { file_path: 'D:\\x.txt' },
    });
    expect(items.every((i) => !(i.kind === 'assistant_text' && i.streaming))).toBe(true);
  });

  it('permissionStep = permissions kinds; tool call awaiting_decision → done', () => {
    const c = dslContext();
    const prompt = c.ids.uuid();
    const ev = events(
      input(c, prompt, 'Run it'),
      turnOpen(c, prompt),
      toolUseBlock(c, 'Bash', { command: 'ls' }, { toolUseId: 'toolu_b' }),
      permissionStep(c, { toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_b' }),
      toolResultMessage(c, 'toolu_b', 'a.txt', {
        toolUseResult: { stdout: 'a.txt', stderr: '', interrupted: false, isImage: false },
      }),
      streamedText(c, 'Done.'),
      turnClose(c, prompt),
    );
    valid(ev);
    const { r, items, kinds } = replay(ev);
    expect(subset(kinds, fixtureKinds('permissions'))).toEqual([]);
    expect(items.find((i) => i.kind === 'tool_call')).toMatchObject({
      status: 'done',
      decision: { outcome: { type: 'allowed' } },
    });
    const statuses = r.steps
      .flatMap((s) => s.ops)
      .flatMap((op) => (op.op === 'item.upsert' && op.item.kind === 'tool_call' ? [op.item.status] : []));
    expect(statuses).toContain('awaiting_decision');
    expect(signalList(r).some((s) => s.type === 'session_state' && s.state === 'requires_action')).toBe(true);
  });

  it('questionStep = ask-user-question kinds, outcome answered', () => {
    const c = dslContext();
    const ev = events(
      turnOpen(c, null),
      questionStep(c, {
        questions: [
          {
            question: 'Color?',
            header: 'C',
            options: [{ label: 'Red', preview: '```\nred\n```' }, { label: 'Blue' }],
          },
        ],
        notes: { 'Color?': 'dark' },
      }),
      turnClose(c, null),
    );
    valid(ev);
    const { items, kinds } = replay(ev);
    expect(subset(kinds, fixtureKinds('ask-user-question'))).toEqual([]);
    expect(items.find((i) => i.kind === 'tool_call')).toMatchObject({
      toolName: 'AskUserQuestion',
      status: 'done',
      decision: { kind: 'question', outcome: { type: 'answered' } },
    });
  });

  it('planStep (revise, then approve) = plan-mode kinds, permission_mode signal, versions', () => {
    const c = dslContext();
    const ev = events(
      turnOpen(c, null),
      planStep(c, { plan: '# v1', feedback: 'Add tests.' }),
      planStep(c, { plan: '# v2', mode: 'acceptEdits' }),
      turnClose(c, null),
    );
    valid(ev);
    const { r, items, kinds } = replay(ev);
    expect(subset(kinds, fixtureKinds('plan-mode'))).toEqual([]);
    const plans = items.filter((i) => i.kind === 'tool_call' && i.toolName === 'ExitPlanMode');
    expect(
      plans.map((p) =>
        p.kind === 'tool_call' ? [p.status, p.decision?.outcome?.type, p.decision?.planVersion] : null,
      ),
    ).toEqual([
      ['denied', 'plan_revised', 1],
      ['done', 'plan_approved', 2],
    ]);
    expect(signalList(r).some((s) => s.type === 'permission_mode' && s.mode === 'acceptEdits')).toBe(true);
  });

  it('subagentRun = subagent kinds: background agent, nested items, background_tasks signal', () => {
    const c = dslContext();
    const ev = events(
      turnOpen(c, null),
      subagentRun(c, { toolUseId: 'toolu_agent', description: 'Ping', prompt: 'Say PONG', reply: 'PONG' }),
      turnClose(c, null),
    );
    valid(ev);
    const { r, items, kinds } = replay(ev);
    expect(subset(kinds, fixtureKinds('subagent'))).toEqual([]);
    expect(items.find((i) => i.kind === 'tool_call' && i.toolUseId === 'toolu_agent')).toMatchObject({
      toolName: 'Agent',
      status: 'done',
      task: { taskId: 'task_toolu_agent', status: 'completed' },
    });
    expect(items.filter((i) => i.parentToolUseId === 'toolu_agent').map((i) => i.kind)).toEqual([
      'thinking',
      'assistant_text',
    ]);
    expect(
      signalList(r)
        .filter((s) => s.type === 'background_tasks')
        .map((s) => s.count),
    ).toEqual([1, 0]);
  });

  it('interruptEpilogue (tool / streaming / now) = interrupt kinds, outcome interrupted', () => {
    for (const variant of ['tool', 'streaming', 'now'] as const) {
      const c = dslContext();
      const prompt = c.ids.uuid();
      const ev = events(
        input(c, prompt, 'Long work'),
        turnOpen(c, prompt),
        ...(variant === 'tool'
          ? [toolUseBlock(c, 'Bash', { command: 'sleep' }, { toolUseId: 'toolu_s' })]
          : [streamedText(c, 'partial')]),
        ...(variant === 'tool'
          ? [permissionStep(c, { toolName: 'Bash', input: { command: 'sleep' }, toolUseId: 'toolu_s' })]
          : []),
        interruptEpilogue(c, {
          prompt,
          toolUseId: variant === 'tool' ? 'toolu_s' : null,
          reason: variant === 'now' ? 'now' : 'interrupt',
        }),
      );
      valid(ev);
      const { r, items, kinds } = replay(ev);
      expect(
        subset(kinds, new Set([...fixtureKinds('interrupt'), ...fixtureKinds('interrupt-requesting')])),
      ).toEqual([]);
      expect(signalList(r).find((s) => s.type === 'turn_result')).toMatchObject({ outcome: 'interrupted' });
      if (variant === 'tool') {
        expect(items.find((i) => i.kind === 'tool_call')).toMatchObject({ status: 'interrupted' });
        expect(items.find((i) => i.kind === 'system' && i.event === 'interrupted')).toMatchObject({
          forToolUse: true,
        });
      }
      if (variant === 'now')
        expect(signalList(r).some((s) => s.type === 'session_state' && s.state === 'idle')).toBe(false);
    }
  });

  it('clearCommand / renameCommand = clear-rename kinds: reset signal, new session id, title', () => {
    const c = dslContext();
    const rename = c.ids.uuid();
    const clear = c.ids.uuid();
    const ev = events(
      input(c, rename, '/rename My title'),
      renameCommand(c, { prompt: rename, title: 'My title' }),
      input(c, clear, '/clear'),
      clearCommand(c, {
        prompt: clear,
        newSessionId: '5e550000-0000-4000-8000-0000000000ff',
        title: 'My title',
      }),
    );
    valid(ev);
    const { r, kinds } = replay(ev);
    expect(subset(kinds, fixtureKinds('clear-rename'))).toEqual([]);
    expect(r.conversations).toHaveLength(2);
    const signals = signalList(r);
    expect(signals.filter((s) => s.type === 'title_changed')).toHaveLength(3);
    expect(signals.find((s) => s.type === 'conversation_reset')).toMatchObject({ trigger: 'clear' });
    expect(
      signals.filter((s) => s.type === 'session_id').map((s) => s.sessionId),
    ).toContain('5e550000-0000-4000-8000-0000000000ff');
    expect(
      signals.filter((s) => s.type === 'turn_result').every((s) => s.synthetic),
    ).toBe(true);
  });

  it('startupFailure / assistantErrorTurn → startup/setup error signals', () => {
    const c = dslContext();
    const prompt = c.ids.uuid();
    const failed = replay(
      events(input(c, prompt, 'x'), startupFailure(c, { reason: 'session_held_by_background', prompt })),
    );
    expect(signalList(failed.r).find((s) => s.type === 'turn_result')).toMatchObject({
      startupFailure: true,
      error: { code: 'SESSION_HELD_ELSEWHERE' },
    });
    const auth = replay(events(input(c, prompt, 'x'), assistantErrorTurn(c, { prompt })));
    expect(signalList(auth.r).find((s) => s.type === 'assistant_error')).toMatchObject({
      error: { code: 'CLAUDE_AUTH_FAILED' },
    });
    expect(auth.kinds.has('system/error')).toBe(true);
  });

  it('crash / closeGate are exit events (with and without msSinceClose)', () => {
    expect(crash(3)).toEqual([
      { seq: 1, tMs: 0, kind: 'exit', payload: { pid: null, code: 3, signal: null } },
    ]);
    expect(closeGate()[0]?.payload).toMatchObject({ code: 0, msSinceClose: 900 });
  });

  it('events() renumbers seq and keeps tMs increasing; frames are unique per context', () => {
    const c = dslContext();
    const ev = events(textTurn(c, { prompt: null, text: 'a' }), [], textTurn(c, { prompt: null, text: 'b' }));
    valid(ev);
    const uuids = ev.flatMap((e) => {
      const payload: unknown = e.payload;
      return typeof payload === 'object' && payload !== null && 'uuid' in payload ? [payload.uuid] : [];
    });
    expect(new Set(uuids).size).toBe(uuids.length);
  });
});
