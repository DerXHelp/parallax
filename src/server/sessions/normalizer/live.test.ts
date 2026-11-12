/**
 * Unit tests of the live adapter for rules the recorded fixtures do not exercise on their own:
 * ordering of decisions/results before the tool call, prompts, finalizeOpen, conversation
 * handling, plan-text exemption, tolerant parsing.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import { sessionOpSchema, type SessionOp } from '@shared/protocol';
import { sampleId } from '@shared/samples';
import type { LiveNormalizer, NormalizerOutput } from '../ports';
import { createLiveNormalizer } from './index';
import { testContext } from './testing/harness';

const AT = new Date('2026-10-15T08:00:00.000Z');
const SESSION = 'live-test-session';

function upserts(out: NormalizerOutput): TranscriptItem[] {
  return out.ops.flatMap((op) => (op.op === 'item.upsert' ? [op.item] : []));
}

function toolUse(id: string, name: string, input: unknown, messageId = `msg_${id}`): unknown {
  return {
    type: 'assistant',
    message: { id: messageId, model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
    uuid: `uuid-${id}`,
    session_id: SESSION,
  };
}

function toolResult(id: string, content: unknown, isError = false, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: `result-${id}`,
    session_id: SESSION,
    ...extra,
  };
}

function fresh(nextOrder = 1): LiveNormalizer {
  return createLiveNormalizer(testContext(sampleId('cv', 1), nextOrder));
}

describe('live normalizer: ordering and ids', () => {
  it('continues at ctx.nextOrder and uses px ids with the order for Parallax-made items', () => {
    const n = fresh(42);
    const out = n.push(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] }, error: 'overloaded', session_id: SESSION },
      AT,
    );
    const items = upserts(out);
    expect(items.map((i) => [i.order, i.kind])).toEqual([
      [42, 'assistant_text'],
      [43, 'system'],
    ]);
    expect(items[1]?.id).toBe(`px:${sampleId('cv', 1)}:43`);
    expect(out.signals).toContainEqual({ type: 'assistant_error', error: { code: 'API_OVERLOADED', params: { reason: 'overloaded' } } });
  });

  it('applies a decision and a result that arrive before the tool call', () => {
    const n = fresh();
    expect(n.attachDecision('toolu_early', { decisionId: sampleId('dc', 1), kind: 'permission', planVersion: null, outcome: null }).ops).toEqual([]);
    expect(n.push(toolResult('toolu_early', 'ok'), AT).ops).toEqual([]);
    const [call] = upserts(n.push(toolUse('toolu_early', 'Bash', { command: 'ls' }), AT));
    expect(call).toMatchObject({ kind: 'tool_call', status: 'done', decision: { decisionId: sampleId('dc', 1) }, result: { isError: false } });
  });

  it('attachDecision maps outcomes to tool statuses (deny + interrupt stays denied after the result)', () => {
    const n = fresh();
    n.push(toolUse('toolu_a', 'Bash', { command: 'rm x' }), AT);
    const ref = { decisionId: sampleId('dc', 2), kind: 'permission' as const, planVersion: null };
    expect(upserts(n.attachDecision('toolu_a', { ...ref, outcome: null }))[0]).toMatchObject({ status: 'awaiting_decision' });
    expect(upserts(n.attachDecision('toolu_a', { ...ref, outcome: { type: 'denied', withMessage: false, interrupt: true } }))[0]).toMatchObject({ status: 'denied' });
    const [after] = upserts(
      n.push(toolResult('toolu_a', "The user doesn't want to proceed with this tool use.", true, { tool_result_meta: [{ id: 'toolu_a', non_execution_kind: 'user-rejected' }] }), AT),
    );
    expect(after).toMatchObject({ status: 'denied' });
    n.push(toolUse('toolu_b', 'Bash', { command: 'sleep 9' }), AT);
    expect(upserts(n.attachDecision('toolu_b', { ...ref, outcome: { type: 'cancelled', reason: 'signal_aborted' } }))[0]).toMatchObject({ status: 'interrupted' });
  });

  it('a permission_denied after the result turns the error into denied', () => {
    const n = fresh();
    n.push(toolUse('toolu_c', 'Bash', { command: 'x' }), AT);
    n.push(toolResult('toolu_c', 'Denied', true), AT);
    const out = n.push({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_c', message: 'Denied', uuid: 'pd-1', session_id: SESSION }, AT);
    expect(upserts(out).map((i) => (i.kind === 'tool_call' ? i.status : i.kind))).toEqual(['system', 'denied']);
  });
});

describe('live normalizer: prompts', () => {
  const prompt = (uuid: string, text: string) => ({ messageUuid: uuid, text, attachments: [], priority: 'next' as const, at: AT });

  it('creates the user_message on lifecycle started, never for a prompt cancelled while queued', () => {
    const n = fresh();
    n.registerPrompt(prompt('11111111-1111-4111-8111-111111111111', '/rename  New name'));
    n.registerPrompt(prompt('22222222-2222-4222-8222-222222222222', 'never runs'));
    const started = n.push({ type: 'command_lifecycle', command_uuid: '11111111-1111-4111-8111-111111111111', state: 'started', session_id: SESSION }, AT);
    expect(upserts(started)).toMatchObject([{ kind: 'user_message', slashCommand: '/rename', priority: 'next', origin: 'human', text: { text: '/rename  New name' } }]);
    const cancelled = n.push({ type: 'command_lifecycle', command_uuid: '22222222-2222-4222-8222-222222222222', state: 'cancelled', session_id: SESSION }, AT);
    expect(upserts(cancelled)).toEqual([]);
    expect(cancelled.signals).toEqual([{ type: 'prompt_lifecycle', messageUuid: '22222222-2222-4222-8222-222222222222', state: 'cancelled' }]);
    // A later started for the cancelled one does not resurrect it.
    expect(upserts(n.push({ type: 'command_lifecycle', command_uuid: '22222222-2222-4222-8222-222222222222', state: 'started', session_id: SESSION }, AT))).toEqual([]);
  });

  it('caps a huge prompt text (blob) and shows foreign user texts with origin other', () => {
    const n = fresh();
    n.registerPrompt(prompt('33333333-3333-4333-8333-333333333333', 'p'.repeat(LIMITS.itemTextChars + 10)));
    const [big] = upserts(n.push({ type: 'command_lifecycle', command_uuid: '33333333-3333-4333-8333-333333333333', state: 'started' }, AT));
    expect(big?.kind === 'user_message' ? big.text.truncated?.totalChars : null).toBe(LIMITS.itemTextChars + 10);
    const [foreign] = upserts(n.push({ type: 'user', message: { content: 'from a channel' }, uuid: 'foreign-1', origin: { kind: 'channel' }, session_id: SESSION }, AT));
    expect(foreign).toMatchObject({ kind: 'user_message', origin: 'other', priority: null, text: { text: 'from a channel' } });
  });

  it('resets the prompt suggestion when the next prompt starts', () => {
    const n = fresh();
    expect(n.push({ type: 'prompt_suggestion', suggestion: 'Run tests', session_id: SESSION }, AT).ops).toEqual([
      { op: 'detail.patch', patch: { promptSuggestion: 'Run tests' } },
    ]);
    n.registerPrompt(prompt('44444444-4444-4444-8444-444444444444', 'go'));
    const out = n.push({ type: 'command_lifecycle', command_uuid: '44444444-4444-4444-8444-444444444444', state: 'started' }, AT);
    expect(out.ops.at(-1)).toEqual({ op: 'detail.patch', patch: { promptSuggestion: null } });
  });
});

describe('live normalizer: finalizeOpen and conversations', () => {
  it('process_exit closes streaming items and interrupts open tool calls; compacting ends', () => {
    const n = fresh();
    n.push({ type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION }, AT);
    n.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_s', model: 'm' } }, parent_tool_use_id: null }, AT);
    n.push({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null }, AT);
    n.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hal' } }, parent_tool_use_id: null }, AT);
    n.push(toolUse('toolu_open', 'Bash', { command: 'sleep 99' }), AT);
    const out = n.finalizeOpen('process_exit');
    expect(upserts(out).map((i) => [i.id, i.kind === 'assistant_text' ? [i.streaming, i.aborted, i.text] : i.kind === 'tool_call' ? i.status : null])).toEqual([
      ['msg_s:0', [false, true, 'Hal']],
      ['msg_toolu_open:0', 'interrupted'],
    ]);
    expect(out.signals).toEqual([{ type: 'compacting', active: false }]);
    expect(n.finalizeOpen('turn_end').ops).toEqual([]);
  });

  it('startConversation without a reset message adds no marker; orders restart', () => {
    const n = fresh(10);
    n.startConversation(sampleId('cv', 9), 1);
    const [item] = upserts(n.push({ type: 'system', subtype: 'notification', key: 'k', text: 't', priority: 'low', uuid: 'note-1' }, AT));
    expect(item).toMatchObject({ id: 'note-1', order: 1 });
  });

  it('marker is emitted once, as the first op of the next output (even attachDecision/finalizeOpen)', () => {
    const n = fresh();
    n.push({ type: 'conversation_reset', uuid: 'reset-1', new_conversation_id: 'reset-1', trigger: 'clear' }, AT);
    n.startConversation(sampleId('cv', 2), 1);
    const first: SessionOp[] = n.finalizeOpen('turn_end').ops;
    expect(first).toMatchObject([{ op: 'item.upsert', item: { id: 'reset-1', order: 1, kind: 'system', event: 'conversation_reset', trigger: 'clear' } }]);
    expect(n.finalizeOpen('turn_end').ops).toEqual([]);
  });
});

describe('live normalizer: sizes and tolerance', () => {
  it('never caps the ExitPlanMode plan text (plan exempt) but caps other strings', () => {
    const n = fresh();
    const plan = 'p'.repeat(LIMITS.itemTextChars + 100);
    const [call] = upserts(n.push(toolUse('toolu_plan', 'ExitPlanMode', { plan, planFilePath: 'C:\\plans\\x.md' }), AT));
    expect(call?.kind === 'tool_call' ? [JSON.stringify(call.input).includes(plan), call.inputTruncated] : null).toEqual([true, null]);
    const [write] = upserts(n.push(toolUse('toolu_w', 'Write', { file_path: 'a', content: plan }), AT));
    expect(write?.kind === 'tool_call' ? write.inputTruncated?.totalChars : null).toBeGreaterThan(LIMITS.itemTextChars);
  });

  it('counts broken frames and publishes unknownCounts via detail.patch', () => {
    const n = fresh();
    expect(n.push(42, AT).ops).toEqual([{ op: 'detail.patch', patch: { unknownCounts: { invalid: 1 } } }]);
    expect(n.push({ type: 'result' }, AT).ops).toEqual([{ op: 'detail.patch', patch: { unknownCounts: { invalid: 1, 'invalid:result': 1 } } }]);
    expect(n.push({ type: 'keep_alive' }, AT)).toEqual({ ops: [], signals: [] });
    expect(n.unknownCounts).toEqual({ invalid: 1, 'invalid:result': 1 });
  });

  it('emits assistant_model only on change and never for <synthetic>; estimates only for the main thread', () => {
    const n = fresh();
    const start = (id: string, model: string, parent: string | null) =>
      n.push({ type: 'stream_event', event: { type: 'message_start', message: { id, model, usage: { input_tokens: 1, output_tokens: 1 } } }, parent_tool_use_id: parent }, AT).signals;
    expect(start('m1', 'claude-haiku-5-5', null)).toEqual([
      { type: 'assistant_model', model: 'claude-haiku-5-5' },
      { type: 'context_estimate', totalTokens: 2, model: 'claude-haiku-5-5', contextWindow: null },
    ]);
    expect(start('m2', 'claude-haiku-5-5', null)).toEqual([]);
    expect(start('m3', 'claude-sonnet-5-5', 'toolu_agent')).toEqual([]);
    expect(start('m4', '<synthetic>', null)).toEqual([]);
  });

  it('carries modelUsage[model].contextWindow of the last result in later estimates (R1-07)', () => {
    const n = fresh();
    const start = (id: string, tokens: number) =>
      n.push({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'claude-haiku-5-5', usage: { input_tokens: tokens, output_tokens: 1 } } }, parent_tool_use_id: null }, AT).signals;
    expect(start('m1', 1).find((s) => s.type === 'context_estimate')).toMatchObject({ contextWindow: null });
    n.push(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'r1',
        session_id: 'session-1',
        num_turns: 1,
        duration_ms: 10,
        is_error: false,
        modelUsage: { 'claude-haiku-5-5': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } },
      },
      AT,
    );
    expect(start('m2', 5).find((s) => s.type === 'context_estimate')).toEqual({
      type: 'context_estimate',
      totalTokens: 6,
      model: 'claude-haiku-5-5',
      contextWindow: 200_000,
    });
  });
});

describe('live normalizer: task output files and lost writes (WP-52)', () => {
  const OUTPUT = 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task-1.output';
  const agentInput = { description: 'Ping', prompt: 'Say PONG', subagent_type: 'general-purpose', run_in_background: true };
  const system = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, uuid: `${subtype}-uuid`, session_id: SESSION, ...fields });
  const asyncLaunched = (outputFile: string) =>
    toolResult('toolu_agent', 'Async agent launched successfully.', false, {
      tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'task-1', description: 'Ping', prompt: 'Say PONG', outputFile },
    });
  const lastTask = (out: NormalizerOutput) => {
    const call = upserts(out).findLast((i) => i.kind === 'tool_call');
    return call?.kind === 'tool_call' ? call.task : undefined;
  };
  const validOps = (out: NormalizerOutput) => {
    for (const op of out.ops) expect(sessionOpSchema.parse(op)).toStrictEqual(op);
    return out;
  };

  it('takes AgentOutput.outputFile of the launch result and task_notification.output_file', () => {
    const n = fresh();
    n.push(toolUse('toolu_agent', 'Agent', agentInput), AT);
    n.push(system('task_started', { task_id: 'task-1', tool_use_id: 'toolu_agent', task_type: 'local_agent', is_backgrounded: true }), AT);
    expect(lastTask(validOps(n.push(asyncLaunched(OUTPUT), AT)))).toMatchObject({ taskId: 'task-1', status: 'running', outputFile: OUTPUT });
    const done = validOps(n.push(system('task_notification', { task_id: 'task-1', tool_use_id: 'toolu_agent', status: 'completed', output_file: `${OUTPUT}2`, summary: 'PONG' }), AT));
    expect(lastTask(done)).toMatchObject({ status: 'completed', summary: 'PONG', outputFile: `${OUTPUT}2` });
  });

  it('keeps a launch result that arrives before task_started for the task', () => {
    const n = fresh();
    n.push(toolUse('toolu_agent', 'Agent', agentInput), AT);
    expect(lastTask(n.push(asyncLaunched(OUTPUT), AT))).toBeNull();
    const started = n.push(system('task_started', { task_id: 'task-1', tool_use_id: 'toolu_agent', task_type: 'local_agent' }), AT);
    expect(lastTask(started)).toMatchObject({ taskId: 'task-1', outputFile: OUTPUT });
    // An empty output_file in the notification keeps the known path.
    const done = n.push(system('task_notification', { task_id: 'task-1', tool_use_id: 'toolu_agent', status: 'stopped', output_file: '', summary: 'x' }), AT);
    expect(lastTask(done)).toMatchObject({ status: 'stopped', outputFile: OUTPUT });
  });

  it("maps '' and missing output files to null and ignores outputFile of other tools", () => {
    const n = fresh();
    const empty = upserts(n.push(system('task_notification', { task_id: 'bash-1', status: 'stopped', output_file: '', summary: 's' }), AT));
    expect(empty[0]).toMatchObject({ kind: 'system', event: 'task_notification', task: { taskId: 'bash-1', outputFile: null } });
    const blank = upserts(n.push({ ...system('task_notification', { task_id: 'bash-2', status: 'completed', output_file: '   ' }), uuid: 'n-2' }, AT));
    expect(blank[0]).toMatchObject({ task: { outputFile: null } });
    const missing = upserts(n.push({ ...system('task_notification', { task_id: 'bash-3', status: 'completed', output_file: 42 }), uuid: 'n-3' }, AT));
    expect(missing[0]).toMatchObject({ task: { outputFile: null } });
    const tooLong = upserts(n.push({ ...system('task_notification', { task_id: 'bash-4', output_file: `C:\\${'x'.repeat(LIMITS.pathChars)}` }), uuid: 'n-4' }, AT));
    expect(tooLong[0]).toMatchObject({ task: { outputFile: null } });
    n.push(toolUse('toolu_bash', 'Bash', { command: 'sleep 9', run_in_background: true }), AT);
    n.push(system('task_started', { task_id: 'bash-5', tool_use_id: 'toolu_bash', task_type: 'local_bash' }), AT);
    const bash = n.push(toolResult('toolu_bash', 'moved', false, { tool_use_result: { backgroundTaskId: 'bash-5', outputFile: OUTPUT } }), AT);
    expect(lastTask(bash)).toMatchObject({ taskId: 'bash-5', outputFile: null });
  });

  const notificationText = (taskId: string, outputFile: string, toolUseId: string | null = null) =>
    `<task-notification>\n<task-id>${taskId}</task-id>\n${toolUseId === null ? '' : `<tool-use-id>${toolUseId}</tool-use-id>\n`}<output-file>${outputFile}</output-file>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>`;
  const userText = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid,
    session_id: SESSION,
    ...extra,
  });
  const TASK_ORIGIN = { kind: 'task-notification', producer: 'session-task', runId: 'run-1' };

  it('takes <output-file> of a live <task-notification> user text with the CLI origin (ADR-152)', () => {
    const n = fresh();
    const out = n.push(userText('tn-1', notificationText('task-9', OUTPUT), { origin: TASK_ORIGIN }), AT);
    expect(upserts(out)[0]).toMatchObject({ kind: 'system', event: 'task_notification', task: { taskId: 'task-9', outputFile: OUTPUT } });
  });

  // R5 probe P1: the same text without the CLI origin never yields an output file (ADR-152).
  it('a <task-notification> text without the CLI origin: prompt (human), no output file (none), dropped (subagent)', () => {
    const secret = 'C:\\Users\\user\\AppData\\Local\\Temp\\r5-p1\\outside\\secret.txt';
    const text = notificationText('task-p1', secret);
    const n = fresh();
    n.push(toolUse('toolu_agent', 'Agent', agentInput), AT);

    // origin human: a normal prompt with the pasted text – also a registered prompt of this client.
    const human = upserts(n.push(userText('p1-human', text, { origin: { kind: 'human' } }), AT));
    expect(human).toEqual([expect.objectContaining({ id: 'p1-human', kind: 'user_message', origin: 'human', text: expect.objectContaining({ text }) as unknown })]);
    n.registerPrompt({ messageUuid: 'p1-registered', text, attachments: [], priority: 'next', at: AT });
    const registered = upserts(n.push(userText('p1-registered', text, { origin: { kind: 'human' } }), AT));
    expect(registered.map((i) => [i.id, i.kind])).toEqual([['p1-registered', 'user_message']]);
    // Another origin (channel) is no notification either.
    expect(upserts(n.push(userText('p1-channel', text, { origin: { kind: 'channel', server: 'x' } }), AT))).toEqual([
      expect.objectContaining({ kind: 'user_message', origin: 'other' }),
    ]);

    // No origin at all (older CLIs): shown as a notification, but without the output file.
    const none = upserts(n.push(userText('p1-none', text), AT));
    expect(none).toEqual([expect.objectContaining({ kind: 'system', event: 'task_notification', task: expect.objectContaining({ taskId: 'task-p1', outputFile: null }) as unknown })]);

    // A subagent message never counts, not even with the CLI origin; the real Agent call stays as it is.
    for (const [uuid, origin] of [['p1-sub', TASK_ORIGIN], ['p1-sub-none', undefined]] as const) {
      const sub = n.push(userText(uuid, notificationText('task-p1', secret, 'toolu_agent'), { parent_tool_use_id: 'toolu_agent', origin }), AT);
      expect(upserts(sub)).toEqual([]);
    }
    const forged = n.push(userText('p1-forged', notificationText('task-p1', secret, 'toolu_agent'), { origin: { kind: 'human' } }), AT);
    expect(upserts(forged).every((i) => i.kind === 'user_message')).toBe(true);
    // The Agent call still has no task (no text above reached it): the launch result waits for task_started.
    expect(lastTask(n.push(asyncLaunched(OUTPUT), AT))).toBeNull();
    expect(n.unknownCounts).toEqual({});
  });

  it('turns system/session_writes_lost into an error item (tolerant of unknown values)', () => {
    const n = fresh();
    const out = validOps(
      n.push(system('session_writes_lost', { error_code: 'ENOSPC', lost: ['transcript', 'global_config', 7], transcript_session_ids: [SESSION], future_field: { a: 1 } }), AT),
    );
    expect(upserts(out)).toEqual([
      expect.objectContaining({
        id: 'session_writes_lost-uuid',
        kind: 'system',
        event: 'error',
        error: { code: 'SESSION_WRITES_LOST', params: { lost: 'transcript,global_config', errorCode: 'ENOSPC' } },
      }),
    ]);
    // No status signal of its own (only the session id every first message carries).
    expect(out.signals.filter((s) => s.type !== 'session_id')).toEqual([]);
    const sparse = n.push({ type: 'system', subtype: 'session_writes_lost', lost: 'not-an-array', uuid: 'swl-2', session_id: SESSION }, AT);
    expect(upserts(sparse)[0]).toMatchObject({ error: { code: 'SESSION_WRITES_LOST', params: { lost: '', errorCode: '' } } });
    expect(n.unknownCounts).toEqual({});
  });
});
