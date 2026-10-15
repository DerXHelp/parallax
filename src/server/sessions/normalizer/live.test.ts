/**
 * Unit tests of the live adapter for rules the recorded fixtures do not exercise on their own:
 * ordering of decisions/results before the tool call, prompts, finalizeOpen, conversation
 * handling, plan-text exemption, tolerant parsing.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import type { TranscriptItem } from '@shared/model';
import type { SessionOp } from '@shared/protocol';
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
      { type: 'context_estimate', totalTokens: 2, model: 'claude-haiku-5-5' },
    ]);
    expect(start('m2', 'claude-haiku-5-5', null)).toEqual([]);
    expect(start('m3', 'claude-sonnet-5-5', 'toolu_agent')).toEqual([]);
    expect(start('m4', '<synthetic>', null)).toEqual([]);
  });
});
