/**
 * Synthetic streams (R0-06): every module is valid fixture format v1 and runs through the live
 * adapter; targeted assertions per SDK type without a recorded fixture plus file snapshots.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import type { SystemItem, ToolCallItem, TranscriptItem } from '@shared/model';
import { sessionOpSchema } from '@shared/protocol';
import { FIXTURE_VERSION, fixtureEventSchema, parseFixture } from '../../../backend/fixture';
import type { StatusSignal } from '../../ports';
import {
  finalItems,
  mergedDetail,
  replayLive,
  signalList,
  snapshotJson,
  timeline,
  type LiveReplay,
} from '../testing/harness';
import { SYNTHETIC_STREAMS } from './index';
import { uuid } from './build';

function stream(name: string) {
  const events = SYNTHETIC_STREAMS[name];
  if (events === undefined) throw new Error(`synthetic stream ${name} missing`);
  return events;
}

function run(name: string): LiveReplay {
  return replayLive({ events: stream(name) });
}

function items(replay: LiveReplay): TranscriptItem[] {
  return Object.values(finalItems(replay)).flat();
}

function item(replay: LiveReplay, id: string): TranscriptItem {
  const found = items(replay).find((i) => i.id === id);
  if (found === undefined) throw new Error(`item ${id} missing`);
  return found;
}

function toolCall(replay: LiveReplay, toolUseId: string): ToolCallItem {
  const found = items(replay).find((i): i is ToolCallItem => i.kind === 'tool_call' && i.toolUseId === toolUseId);
  if (found === undefined) throw new Error(`tool call ${toolUseId} missing`);
  return found;
}

function systems(replay: LiveReplay, event: SystemItem['event']): SystemItem[] {
  return items(replay).filter((i): i is SystemItem => i.kind === 'system' && i.event === event);
}

function signals<T extends StatusSignal['type']>(replay: LiveReplay, type: T): Extract<StatusSignal, { type: T }>[] {
  return replay.steps.flatMap((s) => s.signals).filter((s): s is Extract<StatusSignal, { type: T }> => s.type === type);
}

const names = Object.keys(SYNTHETIC_STREAMS).sort();

describe.each(names)('synthetic stream %s', (name) => {
  it('is valid fixture format v1 (fixtureEventSchema, parseFixture)', () => {
    const events = stream(name);
    for (const event of events) expect(fixtureEventSchema.safeParse(event).success).toBe(true);
    const header = {
      fixtureVersion: FIXTURE_VERSION,
      scenario: name,
      sdkVersion: '0.3.296',
      cliVersion: '2.1.300',
      recordedAt: '2026-10-15T08:00:00.000Z',
      options: { synthetic: true },
    };
    const text = [header, ...events].map((line) => JSON.stringify(line)).join('\n');
    expect(parseFixture(text, name).events).toHaveLength(events.length);
  });

  it('emits schema-true ops and matches the snapshot', async () => {
    const replay = run(name);
    for (const op of replay.steps.flatMap((s) => s.ops)) expect(sessionOpSchema.parse(op)).toStrictEqual(op);
    for (const i of items(replay).filter((x) => x.kind !== 'assistant_text')) {
      expect(JSON.stringify(i).length).toBeLessThanOrEqual(LIMITS.itemTotalChars);
    }
    const snapshot = {
      name,
      conversations: replay.conversations,
      timeline: timeline(replay),
      signals: signalList(replay),
      items: finalItems(replay),
      detail: mergedDetail(replay),
      unknownCounts: replay.normalizer.unknownCounts,
      ignoredCounts: replay.normalizer.ignoredCounts,
    };
    await expect(snapshotJson(snapshot)).toMatchFileSnapshot(`../__snapshots__/synthetic/${name}.json`);
  });
});

describe('synthetic behaviour', () => {
  it('compact + api_retry: compacting on/off, one retry item per series, ended by the next request', () => {
    const r = run('compact-retry');
    expect(signals(r, 'compacting').map((s) => s.active)).toEqual([true, false]);
    expect(signals(r, 'retry').map((s) => s.active)).toEqual([true, false]);
    expect(systems(r, 'compact_boundary')).toMatchObject([{ trigger: 'manual', preTokens: 160_000, postTokens: 30_000 }]);
    expect(systems(r, 'api_retry')).toMatchObject([
      { id: uuid(8), attempt: 2, maxRetries: 10, retryDelayMs: 4000, errorStatus: 529, errorCode: 'API_OVERLOADED', active: false },
    ]);
  });

  it('hooks, informational, notification, memory, local output, suggestion, commands', () => {
    const r = run('hooks-notices');
    expect(systems(r, 'hook')).toMatchObject([
      { id: uuid(4), hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', outcome: 'success', output: { text: 'allowed by policy' } },
    ]);
    expect(systems(r, 'informational')).toMatchObject([{ level: 'warning', preventContinuation: true, tag: 'stop_hook' }]);
    expect(systems(r, 'notification')).toMatchObject([{ key: 'update', priority: 'low' }]);
    expect(systems(r, 'memory_recall')).toMatchObject([
      { mode: 'select', memories: [{ scope: 'personal', content: null }, { scope: 'organization', content: { text: 'Use pnpm.' } }] },
    ]);
    expect(systems(r, 'local_command_output')).toMatchObject([{ text: { text: 'Total cost: $0.00' } }]);
    const detail = mergedDetail(r);
    expect(detail.promptSuggestion).toBe('Now run the tests');
    expect(detail.commands).toEqual([
      { name: 'clear', description: 'Clear the conversation', argumentHint: '', aliases: ['reset', 'new'], builtin: true },
      { name: 'deploy', description: 'Project skill', argumentHint: '<env>', aliases: [], builtin: false },
    ]);
  });

  it('auto mode denial: permission_denied item, tool status denied, denial counted', () => {
    const r = run('auto-mode-denied');
    expect(systems(r, 'permission_denied')).toMatchObject([
      { toolName: 'Bash', toolUseId: 'toolu_syn_denied_1', reasonType: 'classifier' },
    ]);
    expect(toolCall(r, 'toolu_syn_denied_1').status).toBe('denied');
    expect(items(r).find((i) => i.kind === 'turn_result')).toMatchObject({ permissionDenials: 1 });
  });

  it('tasks: background agent ends with its task (failed → error), tool_progress, orphan notification', () => {
    const r = run('tasks-progress');
    expect(toolCall(r, 'toolu_syn_agent_1')).toMatchObject({
      status: 'error',
      task: {
        taskId: 'task-a',
        taskType: 'local_agent',
        status: 'failed',
        subagentType: 'Explore',
        isBackgrounded: true,
        summary: 'Agent failed',
        usage: { totalTokens: 1500, toolUses: 4, durationMs: 5000 },
        endedAt: new Date(1_792_051_200_000).toISOString(),
      },
    });
    expect(toolCall(r, 'toolu_syn_bash_1')).toMatchObject({ status: 'done', elapsedSeconds: 2 });
    expect(systems(r, 'task_notification')).toMatchObject([{ task: { taskId: 'task-orphan', status: 'completed' } }]);
    expect(signals(r, 'background_tasks').map((s) => s.count)).toEqual([1, 0]);
  });

  it('refusal fallback: refused partial and superseded frames are removed', () => {
    const r = run('refusal-fallback');
    const removed = r.steps.flatMap((s) => s.ops).filter((op) => op.op === 'item.remove');
    expect(removed).toEqual([
      { op: 'item.remove', itemId: 'msg_syn_refused_1:0' },
      { op: 'item.remove', itemId: 'msg_syn_refused_2:0' },
    ]);
    expect(items(r).filter((i) => i.kind === 'assistant_text').map((i) => i.id)).toEqual(['msg_syn_refused_3:0']);
    expect(systems(r, 'model_fallback')).toMatchObject([{ originalModel: 'claude-opus-5-5', fallbackModel: 'claude-sonnet-5-5' }]);
    expect(systems(r, 'error')).toMatchObject([{ error: { code: 'MODEL_REFUSAL' } }]);
    expect(signals(r, 'assistant_model').map((s) => s.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });

  it('rate limits: banner for allowed_warning, rejected = error (credits_required → setup code)', () => {
    const r = run('rate-limits');
    expect(systems(r, 'rate_limit').map((i) => (i.event === 'rate_limit' ? i.info.status : null))).toEqual([
      'allowed_warning',
      'rejected',
      'rejected',
    ]);
    expect(signals(r, 'rate_limit').map((s) => s.info.status)).toEqual(['allowed_warning', 'rejected', 'rejected', 'allowed']);
    expect(signals(r, 'assistant_error').map((s) => s.error.code)).toEqual(['RATE_LIMIT_REJECTED', 'CLAUDE_BILLING']);
    expect(signals(r, 'rate_limit')[1]?.info.resetsAt).toBe(new Date(1_792_051_200_000).toISOString());
    expect(mergedDetail(r).rateLimit).toMatchObject({ status: 'allowed' });
  });

  it('errors: assistant auth error, then a startup failure (synthetic turn with error)', () => {
    const r = run('errors');
    expect(item(r, 'syn-api-error-1:0')).toMatchObject({ kind: 'assistant_text', model: '<synthetic>' });
    expect(item(r, uuid(4))).toMatchObject({ kind: 'system', event: 'error', error: { code: 'CLAUDE_AUTH_FAILED' } });
    expect(signals(r, 'assistant_model')).toEqual([]);
    expect(signals(r, 'assistant_error').map((s) => s.error.code)).toEqual(['CLAUDE_AUTH_FAILED']);
    const results = signals(r, 'turn_result');
    expect(results.map((s) => [s.outcome, s.error?.code, s.synthetic, s.startupFailure])).toEqual([
      ['error', 'CLAUDE_AUTH_FAILED', false, false],
      ['error', 'SHELL_TOOL_MISSING', true, true],
    ]);
    // The auth error has its item already; the startup failure gets its own (px id).
    expect(systems(r, 'error').map((i) => i.id)).toEqual([uuid(4), expect.stringMatching(/^px:cv_[0-9a-f]{32}:\d+$/)]);
  });

  it('newer CLI: unknown types/enums are counted, ignored types counted separately', () => {
    const r = run('unknown-types');
    expect(r.normalizer.unknownCounts).toEqual({
      'enum/permissionMode:turbo': 2,
      'enum/effort:ultra': 1,
      brand_new_type: 1,
      'system/brand_new_subtype': 1,
      'invalid:assistant': 1,
      'system/session_state_changed:paused': 1,
      'assistant/block:server_widget': 1,
      'command_lifecycle/deferred': 1,
    });
    expect(r.normalizer.ignoredCounts).toEqual({ 'system/files_persisted': 1, tool_use_summary: 1, auth_status: 1 });
    expect(systems(r, 'unknown').map((i) => (i.event === 'unknown' ? [i.sdkType, i.sdkSubtype] : null))).toEqual([
      ['brand_new_type', null],
      ['system', 'brand_new_subtype'],
      ['assistant', 'server_widget'],
    ]);
    expect(signals(r, 'init')[0]?.permissionMode).toBeNull();
    expect(signals(r, 'permission_mode')).toEqual([{ type: 'permission_mode', mode: null }]);
    expect(mergedDetail(r).init).toMatchObject({ permissionMode: null, effort: null });
    expect(mergedDetail(r).unknownCounts).toEqual(r.normalizer.unknownCounts);
  });

  it('large output: caps, blobs, dedupe, images; every item within the budget', () => {
    const r = run('large-output');
    const write = toolCall(r, 'toolu_syn_write_big');
    expect(write.inputTruncated?.totalChars).toBeGreaterThan(60 * 1024);
    expect(JSON.stringify(write.input).length).toBeLessThan(LIMITS.itemTotalChars);
    expect(write.result?.structured).toBeNull();
    expect(write.result?.structuredTruncated?.totalChars).toBeGreaterThan(LIMITS.itemStructuredChars);
    const bash = toolCall(r, 'toolu_syn_bash_big');
    const text = bash.result?.content[0];
    expect(text?.type === 'text' ? text.text.truncated?.totalChars : null).toBeGreaterThan(LIMITS.itemTextChars);
    // stdout/stderr are in the (full) result text → removed from structured (R0-11).
    expect(bash.result?.structured).toEqual({ interrupted: false, isImage: false, noOutputExpected: false });
    expect(toolCall(r, 'toolu_syn_read').result?.structured).toEqual({
      type: 'text',
      file: { filePath: 'D:\\work\\synthetic\\a.txt', numLines: 2, startLine: 1, totalLines: 2 },
    });
    const shot = toolCall(r, 'toolu_syn_screenshot').result?.content;
    expect(shot?.map((c) => c.type)).toEqual(['text', 'image']);
    expect(shot?.[1]).toMatchObject({ type: 'image', image: { mediaType: 'image/png', bytes: 70 } });
    const dump = toolCall(r, 'toolu_syn_mcp_big').result;
    expect(dump?.structured).toBeNull();
    expect(dump?.structuredTruncated?.blobId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ctx.blobs.size).toBeGreaterThanOrEqual(5);
  });

  it('older CLI without msg_lifecycle_v1: prompt items from user_message_uuids, at the latest at the result', () => {
    const r = run('legacy-cli');
    const created = r.steps.flatMap((s) =>
      s.ops.flatMap((op) => (op.op === 'item.upsert' && op.item.kind === 'user_message' ? [[s.label, op.item.id]] : [])),
    );
    expect(created).toEqual([
      ['system/status', uuid(1000)],
      ['result/success', uuid(1001)],
    ]);
  });

  it('aborted streams: aborted text, closed thinking (clipped at the cap), interrupted tool with parsed input', () => {
    const r = run('aborted-stream');
    expect(item(r, 'msg_syn_abort_1:0')).toMatchObject({ kind: 'assistant_text', aborted: true, streaming: false });
    const thinking = item(r, 'msg_syn_abort_2:0');
    expect(thinking.kind === 'thinking' ? [thinking.streaming, thinking.text.text.length] : null).toEqual([
      false,
      LIMITS.itemTextChars,
    ]);
    expect(toolCall(r, 'toolu_syn_abort')).toMatchObject({ status: 'interrupted', input: { command: 'ls' }, inputPartial: null });
    expect(item(r, 'msg_syn_abort_2:2')).toMatchObject({ kind: 'assistant_text', text: 'Partial', aborted: true });
    expect(r.normalizer.ignoredCounts).toEqual({ 'stream/delta:citations_delta': 1 });
  });

  it('after /clear no ops for items of the old conversation (R0-05f); new session id from the next frames', () => {
    const r = run('stale-conversation');
    expect(r.conversations).toHaveLength(2);
    const afterReset = r.steps.slice(r.steps.findIndex((s) => s.label === 'engine/conversation.reset') + 1);
    const touched = afterReset.flatMap((s) => s.ops).filter((op) => op.op === 'item.upsert' && op.item.kind === 'tool_call');
    expect(touched).toEqual([]);
    expect(r.normalizer.ignoredCounts).toEqual({ staleConversation: 2 });
    const second = finalItems(r)[r.conversations[1] ?? ''] ?? [];
    expect(second[0]).toMatchObject({ kind: 'system', event: 'conversation_reset', trigger: 'clear', order: 1 });
    expect(signals(r, 'session_id').map((s) => s.sessionId)).toEqual([
      '5e550000-0000-4000-8000-000000000001',
      '5e550000-0000-4000-8000-000000000002',
    ]);
    expect(signals(r, 'conversation_reset')).toEqual([
      { type: 'conversation_reset', trigger: 'clear', correlationId: '96ce0000-0000-4000-8000-000000000001' },
    ]);
  });
});
