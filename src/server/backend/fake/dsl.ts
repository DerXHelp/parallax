/**
 * DSL for synthetic engine scenarios (WP-13 §3.3): higher building blocks (turns, streamed
 * blocks, tool calls, decisions, subagents, interrupt, /clear, /rename, failures, crash) on top of
 * the WP-12 frame factories (`sessions/normalizer/synthetic/build.ts`) – no second set of
 * factories. Every building block returns `FixtureEvent[]` (fixture format v1); `events(...)`
 * joins parts with gap-free `seq` and increasing `tMs`. Ids and timestamps come from the
 * `DslContext` (deterministic by default), so every frame of a scenario is unique.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@shared/common';
import {
  SESSION_ID,
  assistant,
  init,
  input as inputFrame,
  messageStart,
  msg,
  result,
  stream,
  system,
  toolResult,
  usage,
} from '../../sessions/normalizer/synthetic/build';
import type { EventKind, FixtureEvent } from '../fixture';
import { FAKE_TERMINAL_COMMANDS } from './defaults';
import type { FakeIds } from './types';

export type Step = readonly [EventKind, unknown];

export interface DslContext {
  readonly sessionId: string;
  readonly ids: FakeIds;
  /** Full model id (init.model, assistant.model). */
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly cwd: string;
  /** ISO time of assistant/user frames. */
  timestamp(): string;
  /** tMs distance of consecutive events (recorded time, scaled by the player's speed). */
  readonly stepMs: number;
}

/** Deterministic ids: `00000000-0000-4000-a000-<n>`, `msg_fake_<n>`, `toolu_fake_<n>`. */
export function sequentialIds(): FakeIds {
  let n = 0;
  const next = () => (n += 1);
  return {
    uuid: () => `00000000-0000-4000-a000-${next().toString(16).padStart(12, '0')}`,
    messageId: () => `msg_fake_${String(next()).padStart(6, '0')}`,
    toolUseId: () => `toolu_fake_${String(next()).padStart(6, '0')}`,
  };
}

/** Random ids for the dev mode. */
export function randomIds(): FakeIds {
  return {
    uuid: () => randomUUID(),
    messageId: () => `msg_fake_${randomBytes(12).toString('hex')}`,
    toolUseId: () => `toolu_fake_${randomBytes(12).toString('hex')}`,
  };
}

const BASE_TIME = Date.parse('2026-10-15T08:00:00.000Z');

export function dslContext(p: Partial<DslContext> = {}): DslContext {
  let tick = 0;
  return {
    sessionId: p.sessionId ?? SESSION_ID,
    ids: p.ids ?? sequentialIds(),
    model: p.model ?? 'claude-haiku-5-5',
    permissionMode: p.permissionMode ?? 'default',
    cwd: p.cwd ?? 'D:\\work\\fake',
    timestamp: p.timestamp ?? (() => new Date(BASE_TIME + (tick += 1)).toISOString()),
    stepMs: p.stepMs ?? 10,
  };
}

// ---- Low-level helpers ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Overwrites payload fields of a step (the WP-12 factories fix uuid/session_id themselves). */
export function patch(step: Step, fields: Record<string, unknown>): Step {
  const [kind, payload] = step;
  return [kind, { ...(isRecord(payload) ? payload : {}), ...fields }];
}

/** A message frame of this context: own uuid and session id. */
export function frame(c: DslContext, step: Step, fields: Record<string, unknown> = {}): Step {
  return patch(step, { uuid: c.ids.uuid(), session_id: c.sessionId, ...fields });
}

/** Steps → events with seq 1… and tMs = index × stepMs. */
export function toEvents(steps: readonly Step[], stepMs = 10): FixtureEvent[] {
  return steps.map(([kind, payload], index) => ({ seq: index + 1, tMs: index * stepMs, kind, payload }));
}

/** Joins building blocks: gap-free seq, tMs continues after each part (+10 ms). */
export function events(...parts: readonly (readonly FixtureEvent[])[]): FixtureEvent[] {
  const out: FixtureEvent[] = [];
  let offset = 0;
  for (const part of parts) {
    const first = part[0];
    if (first === undefined) continue;
    for (const event of part) {
      out.push({ ...event, seq: out.length + 1, tMs: offset + (event.tMs - first.tMs) });
    }
    offset = (out.at(-1)?.tMs ?? 0) + 10;
  }
  return out;
}

function chunks(text: string, count: number): string[] {
  if (text.length === 0) return [];
  const n = Math.max(1, Math.min(count, text.length));
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const state = (c: DslContext, value: 'running' | 'requires_action' | 'idle'): Step =>
  frame(c, system(0, 'session_state_changed', { state: value }));

const lifecycle = (c: DslContext, prompt: string, value: string): Step =>
  frame(c, msg({ type: 'command_lifecycle', command_uuid: prompt, state: value }));

const initFrame = (c: DslContext): Step =>
  frame(
    c,
    init(
      0,
      {
        cwd: c.cwd,
        model: c.model,
        permissionMode: c.permissionMode,
        // Phase 2 (ADR-108): like a CLI that reports its terminal-only commands.
        terminal_slash_commands: [...FAKE_TERMINAL_COMMANDS],
      },
      c.sessionId,
    ),
  );

const userText = (c: DslContext, text: string): Step =>
  frame(
    c,
    msg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      timestamp: c.timestamp(),
    }),
  );

function resultFrame(c: DslContext, prompt: string | null, extra: Record<string, unknown>): Step {
  return frame(
    c,
    result(0, {
      ...(prompt === null ? {} : { user_message_uuid: prompt, user_message_uuids: [prompt] }),
      ...extra,
    }),
  );
}

// ---- Blocks of an assistant message ----

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export const textBlock = (text: string): Block => ({ type: 'text', text });
export const thinkingContent = (thinking: string): Block => ({ type: 'thinking', thinking });
export const toolUseContent = (name: string, input: Record<string, unknown>, id: string): Block => ({
  type: 'tool_use',
  id,
  name,
  input,
});

function startOf(block: Block): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'thinking':
      return { type: 'thinking', thinking: '', signature: '' };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {} };
  }
}

function deltasOf(block: Block, count: number): Record<string, unknown>[] {
  switch (block.type) {
    case 'text':
      return chunks(block.text, count).map((text) => ({ type: 'text_delta', text }));
    case 'thinking':
      return [
        ...chunks(block.thinking, count).map((thinking) => ({ type: 'thinking_delta', thinking })),
        { type: 'signature_delta', signature: '<SIGNATURE>' },
      ];
    case 'tool_use':
      return chunks(JSON.stringify(block.input), Math.max(2, Math.min(count, 4))).map((partial) => ({
        type: 'input_json_delta',
        partial_json: partial,
      }));
  }
}

function finalOf(block: Block): Record<string, unknown> {
  return block.type === 'thinking'
    ? { type: 'thinking', thinking: block.thinking, signature: '<SIGNATURE>' }
    : { ...block };
}

export interface AssistantMessageOptions {
  /** Default: streamed in the main thread, not streamed in a subagent (F.11). */
  streamed?: boolean;
  parentToolUseId?: string | null;
  model?: string;
  messageId?: string;
  /** `assistant.error` (e.g. authentication_failed). */
  error?: string;
  /** Deltas per block (default 3). */
  chunks?: number;
  stepMs?: number;
  extra?: Record<string, unknown>;
}

/**
 * One API message: message_start, per block content_block_start → deltas → final assistant
 * message (one per block, same message.id) → content_block_stop, then message_delta/message_stop.
 */
export function assistantMessage(
  c: DslContext,
  blocks: readonly Block[],
  o: AssistantMessageOptions = {},
): FixtureEvent[] {
  const id = o.messageId ?? c.ids.messageId();
  const model = o.model ?? c.model;
  const parent = o.parentToolUseId ?? null;
  const streamed = o.streamed ?? parent === null;
  const streamStep = (event: Record<string, unknown>): Step =>
    frame(c, stream(0, id, event), { parent_tool_use_id: parent });
  const steps: Step[] = [];
  if (streamed) steps.push(frame(c, messageStart(0, id, model), { parent_tool_use_id: parent }));
  blocks.forEach((block, index) => {
    if (streamed) {
      steps.push(streamStep({ type: 'content_block_start', index, content_block: startOf(block) }));
      for (const delta of deltasOf(block, o.chunks ?? 3))
        steps.push(streamStep({ type: 'content_block_delta', index, delta }));
    }
    steps.push(
      frame(
        c,
        assistant(
          0,
          id,
          finalOf(block),
          {
            parent_tool_use_id: parent,
            timestamp: c.timestamp(),
            ...(o.error === undefined ? {} : { error: o.error }),
            ...o.extra,
          },
          model,
        ),
      ),
    );
    if (streamed) steps.push(streamStep({ type: 'content_block_stop', index }));
  });
  if (streamed) {
    const stopReason = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    steps.push(streamStep({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: usage() }));
    steps.push(streamStep({ type: 'message_stop' }));
  }
  return toEvents(steps, o.stepMs ?? c.stepMs);
}

/** A streamed text answer (one API message). */
export function streamedText(c: DslContext, text: string, o: AssistantMessageOptions = {}): FixtureEvent[] {
  return assistantMessage(c, [textBlock(text)], o);
}

/** A streamed thinking block (one API message). */
export function thinkingBlock(
  c: DslContext,
  thinking: string,
  o: AssistantMessageOptions = {},
): FixtureEvent[] {
  return assistantMessage(c, [thinkingContent(thinking)], o);
}

/** A tool call streamed with input_json_delta (one API message). */
export function toolUseBlock(
  c: DslContext,
  name: string,
  input: Record<string, unknown>,
  o: AssistantMessageOptions & { toolUseId?: string; thinking?: string } = {},
): FixtureEvent[] {
  const blocks: Block[] = [];
  if (o.thinking !== undefined) blocks.push(thinkingContent(o.thinking));
  blocks.push(toolUseContent(name, input, o.toolUseId ?? c.ids.toolUseId()));
  return assistantMessage(c, blocks, o);
}

/** The tool_result user message. */
export function toolResultMessage(
  c: DslContext,
  toolUseId: string,
  content: unknown,
  o: { isError?: boolean; toolUseResult?: unknown; parentToolUseId?: string | null } = {},
): FixtureEvent[] {
  return toEvents([
    frame(
      c,
      toolResult(
        0,
        toolUseId,
        content,
        {
          parent_tool_use_id: o.parentToolUseId ?? null,
          timestamp: c.timestamp(),
          ...(o.toolUseResult === undefined ? {} : { tool_use_result: o.toolUseResult }),
        },
        o.isError ?? false,
      ),
    ),
  ]);
}

// ---- Turns ----

/** The pushed prompt (input gate). */
export function input(
  _c: DslContext,
  uuid: string,
  text: string,
  priority: 'next' | 'now' = 'next',
): FixtureEvent[] {
  return toEvents([inputFrame(uuid, text, priority)]);
}

/** running, lifecycle queued/started (with prompt), init, status requesting. */
export function turnOpen(c: DslContext, prompt: string | null): FixtureEvent[] {
  const steps: Step[] = [state(c, 'running')];
  if (prompt !== null) steps.push(lifecycle(c, prompt, 'queued'), lifecycle(c, prompt, 'started'));
  steps.push(initFrame(c));
  steps.push(
    frame(
      c,
      system(0, 'status', {
        status: 'requesting',
        ...(prompt === null ? {} : { user_message_uuids: [prompt] }),
      }),
    ),
  );
  return toEvents(steps, c.stepMs);
}

export interface TurnCloseOptions {
  /** Fields of the result message (subtype, is_error, terminal_reason, num_turns …). */
  result?: Record<string, unknown>;
  /** Lifecycle state of the prompt (default completed). */
  lifecycle?: 'completed' | 'cancelled';
  /** Emit session_state idle (default true; false while background work keeps the turn going, F.11). */
  idle?: boolean;
}

/** result, lifecycle completed/cancelled, idle (F.10: result before idle). */
export function turnClose(c: DslContext, prompt: string | null, o: TurnCloseOptions = {}): FixtureEvent[] {
  const steps: Step[] = [resultFrame(c, prompt, o.result ?? {})];
  if (prompt !== null) steps.push(lifecycle(c, prompt, o.lifecycle ?? 'completed'));
  if (o.idle !== false) steps.push(state(c, 'idle'));
  return toEvents(steps, c.stepMs);
}

/** A complete answer turn: open, optional thinking, streamed text, result, idle. */
export function textTurn(
  c: DslContext,
  o: {
    prompt: string | null;
    text: string;
    thinking?: string;
    chunks?: number;
    stepMs?: number;
    idle?: boolean;
  },
): FixtureEvent[] {
  const blocks: Block[] = [];
  if (o.thinking !== undefined) blocks.push(thinkingContent(o.thinking));
  blocks.push(textBlock(o.text));
  return events(
    turnOpen(c, o.prompt),
    assistantMessage(c, blocks, {
      ...(o.chunks === undefined ? {} : { chunks: o.chunks }),
      ...(o.stepMs === undefined ? {} : { stepMs: o.stepMs }),
    }),
    turnClose(c, o.prompt, { result: { result: o.text }, ...(o.idle === undefined ? {} : { idle: o.idle }) }),
  );
}

// ---- Decisions ----

export interface PermissionStepSpec {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  suggestions?: PermissionUpdate[];
  /** Further canUseTool options (decisionReason, blockedPath, requiresUserInteraction …). */
  options?: Record<string, unknown>;
  /** Expected engine answer (`decision` event); null = none; default: allow with the input. */
  decision?: PermissionResult | null;
  /** Fake-only: do not block (subagents ask in parallel); the decision comes later (expectDecision). */
  parallel?: boolean;
  agentId?: string;
}

const canUseToolStep = (c: DslContext, spec: PermissionStepSpec): Step => [
  'canUseTool',
  {
    toolName: spec.toolName,
    input: spec.input,
    options: {
      displayName: spec.toolName,
      toolUseID: spec.toolUseId,
      requestId: c.ids.uuid(),
      ...(spec.suggestions === undefined ? {} : { suggestions: spec.suggestions }),
      ...(spec.agentId === undefined ? {} : { agentID: spec.agentId }),
      ...spec.options,
    },
    signalAborted: false,
    ...(spec.parallel === true ? { fake: { parallel: true } } : {}),
  },
];

const allowWith = (input: Record<string, unknown>): PermissionResult => ({
  behavior: 'allow',
  updatedInput: input,
  decisionClassification: 'user_temporary',
});

/** requires_action, canUseTool (gate), expected decision, running. */
export function permissionStep(c: DslContext, spec: PermissionStepSpec): FixtureEvent[] {
  const steps: Step[] = [state(c, 'requires_action'), canUseToolStep(c, spec)];
  if (spec.parallel === true) return toEvents(steps, c.stepMs);
  const decision = spec.decision === undefined ? allowWith(spec.input) : spec.decision;
  if (decision !== null)
    steps.push(['decision', { toolName: spec.toolName, toolUseID: spec.toolUseId, result: decision }]);
  steps.push(state(c, 'running'));
  return toEvents(steps, c.stepMs);
}

/** The expected answer of an earlier parallel canUseTool (join point). */
export function expectDecision(
  _c: DslContext,
  toolName: string,
  toolUseId: string,
  decision: PermissionResult,
): FixtureEvent[] {
  return toEvents([['decision', { toolName, toolUseID: toolUseId, result: decision }]]);
}

export interface QuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

/** AskUserQuestion (F.5): tool call, decision (first option unless given), tool result. */
export function questionStep(
  c: DslContext,
  spec: {
    toolUseId?: string;
    questions: QuestionSpec[];
    answers?: Record<string, string>;
    notes?: Record<string, string>;
  },
): FixtureEvent[] {
  const toolUseId = spec.toolUseId ?? c.ids.toolUseId();
  const questions = spec.questions.map((q) => ({
    question: q.question,
    header: q.header ?? '',
    options: q.options.map((o) => ({
      label: o.label,
      description: o.description ?? '',
      ...(o.preview === undefined ? {} : { preview: o.preview }),
    })),
    multiSelect: q.multiSelect ?? false,
  }));
  const answers =
    spec.answers ?? Object.fromEntries(spec.questions.map((q) => [q.question, q.options[0]?.label ?? '']));
  const annotations = Object.fromEntries(
    Object.entries(spec.notes ?? {}).map(([question, notes]) => [question, { notes }]),
  );
  const input = { questions };
  const updatedInput = { ...input, answers, annotations };
  const answered = Object.entries(answers)
    .map(([q, a]) => `"${q}"="${a}"`)
    .join(', ');
  return events(
    toolUseBlock(c, 'AskUserQuestion', input, { toolUseId }),
    permissionStep(c, {
      toolName: 'AskUserQuestion',
      input,
      toolUseId,
      options: { requiresUserInteraction: true },
      decision: { behavior: 'allow', updatedInput, decisionClassification: 'user_temporary' },
    }),
    toolResultMessage(c, toolUseId, `The user answered: ${answered}.`, { toolUseResult: updatedInput }),
  );
}

/** ExitPlanMode (F.6, C.4): approve with a mode (system/status follows) or revise with feedback. */
export function planStep(
  c: DslContext,
  spec: { toolUseId?: string; plan: string; planFilePath?: string; mode?: PermissionMode; feedback?: string },
): FixtureEvent[] {
  const toolUseId = spec.toolUseId ?? c.ids.toolUseId();
  const input = {
    plan: spec.plan,
    planFilePath: spec.planFilePath ?? 'C:\\Users\\user\\.claude\\plans\\fake-plan.md',
  };
  const mode = spec.mode ?? 'acceptEdits';
  if (spec.feedback !== undefined) {
    return events(
      toolUseBlock(c, 'ExitPlanMode', input, { toolUseId }),
      permissionStep(c, {
        toolName: 'ExitPlanMode',
        input,
        toolUseId,
        options: { requiresUserInteraction: true },
        decision: { behavior: 'deny', message: spec.feedback, decisionClassification: 'user_reject' },
      }),
      toolResultMessage(c, toolUseId, spec.feedback, {
        isError: true,
        toolUseResult: `Error: ${spec.feedback}`,
      }),
    );
  }
  return events(
    toolUseBlock(c, 'ExitPlanMode', input, { toolUseId }),
    permissionStep(c, {
      toolName: 'ExitPlanMode',
      input,
      toolUseId,
      options: { requiresUserInteraction: true },
      decision: {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
        decisionClassification: 'user_temporary',
      },
    }),
    toEvents([frame(c, system(0, 'status', { status: null, permissionMode: mode }))]),
    toolResultMessage(c, toolUseId, 'User has approved your plan. You can now start coding.', {
      toolUseResult: { plan: spec.plan, isAgent: false, filePath: input.planFilePath, planWasEdited: false },
    }),
  );
}

// ---- Subagents (F.11) ----

export interface SubagentSpec {
  toolUseId?: string;
  taskId?: string;
  description: string;
  prompt: string;
  reply: string;
}

/** Agent tool launch in the background: background_tasks_changed, task_started, async tool result. */
export function subagentLaunch(
  c: DslContext,
  spec: SubagentSpec & { toolUseId: string; taskId: string },
): FixtureEvent[] {
  const input = { subagent_type: 'general-purpose', description: spec.description, prompt: spec.prompt };
  return events(
    toolUseBlock(c, 'Agent', input, { toolUseId: spec.toolUseId }),
    toEvents(
      [
        frame(
          c,
          system(0, 'background_tasks_changed', {
            tasks: [
              {
                task_id: spec.taskId,
                task_type: 'local_agent',
                subagent_type: 'general-purpose',
                description: spec.description,
              },
            ],
          }),
        ),
        frame(
          c,
          system(0, 'task_started', {
            task_id: spec.taskId,
            tool_use_id: spec.toolUseId,
            description: spec.description,
            subagent_type: 'general-purpose',
            is_backgrounded: true,
            spawn_depth: 1,
            task_type: 'local_agent',
            prompt: spec.prompt,
          }),
        ),
      ],
      c.stepMs,
    ),
    toolResultMessage(
      c,
      spec.toolUseId,
      [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${spec.taskId}` }],
      {
        toolUseResult: {
          isAsync: true,
          status: 'async_launched',
          agentId: spec.taskId,
          description: spec.description,
          prompt: spec.prompt,
        },
      },
    ),
  );
}

/** End of a background agent: task_updated, task_notification, background_tasks_changed (rest). */
export function subagentEnd(
  c: DslContext,
  spec: {
    toolUseId: string;
    taskId: string;
    summary: string;
    remaining?: { taskId: string; description: string }[];
  },
): FixtureEvent[] {
  return toEvents(
    [
      frame(
        c,
        system(0, 'task_updated', {
          task_id: spec.taskId,
          patch: { status: 'completed', end_time: BASE_TIME },
        }),
      ),
      frame(
        c,
        system(0, 'task_notification', {
          task_id: spec.taskId,
          tool_use_id: spec.toolUseId,
          status: 'completed',
          output_file: '',
          summary: spec.summary,
          usage: { total_tokens: 1200, tool_uses: 0, duration_ms: 2000 },
        }),
      ),
      frame(
        c,
        system(0, 'background_tasks_changed', {
          tasks: (spec.remaining ?? []).map((t) => ({
            task_id: t.taskId,
            task_type: 'local_agent',
            subagent_type: 'general-purpose',
            description: t.description,
          })),
        }),
      ),
    ],
    c.stepMs,
  );
}

/** A complete background agent run: launch, subagent messages (parent_tool_use_id), end. */
export function subagentRun(c: DslContext, spec: SubagentSpec): FixtureEvent[] {
  const toolUseId = spec.toolUseId ?? c.ids.toolUseId();
  const taskId = spec.taskId ?? `task_${toolUseId}`;
  return events(
    subagentLaunch(c, { ...spec, toolUseId, taskId }),
    assistantMessage(c, [thinkingContent('The task is simple.'), textBlock(spec.reply)], {
      parentToolUseId: toolUseId,
    }),
    subagentEnd(c, { toolUseId, taskId, summary: spec.reply }),
  );
}

// ---- Interrupt (F.10) ----

export const TOOL_REJECTED_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/**
 * End of an interrupted turn: with a running tool → rejected tool result + "[Request interrupted by
 * user for tool use]" + aborted_tools; while streaming → "[Request interrupted by user]" +
 * aborted_streaming; `now` (prompt with priority now, F.9) → result success/aborted_tools, no idle.
 */
export function interruptEpilogue(
  c: DslContext,
  o: { prompt: string | null; toolUseId?: string | null; reason?: 'interrupt' | 'now' },
): FixtureEvent[] {
  const toolUseId = o.toolUseId ?? null;
  if (o.reason === 'now') {
    return turnClose(c, o.prompt, {
      result: { subtype: 'success', terminal_reason: 'aborted_tools', stop_reason: 'tool_use' },
      lifecycle: 'cancelled',
      idle: false,
    });
  }
  const parts: FixtureEvent[][] = [];
  if (toolUseId !== null) {
    parts.push(
      toolResultMessage(c, toolUseId, TOOL_REJECTED_TEXT, {
        isError: true,
        toolUseResult: 'User rejected tool use',
      }),
    );
  }
  parts.push(
    toEvents([
      userText(
        c,
        toolUseId === null ? '[Request interrupted by user]' : '[Request interrupted by user for tool use]',
      ),
    ]),
  );
  parts.push(
    turnClose(c, o.prompt, {
      result: {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: toolUseId === null ? 'aborted_streaming' : 'aborted_tools',
        stop_reason: toolUseId === null ? null : 'tool_use',
        result: undefined,
      },
      lifecycle: 'cancelled',
    }),
  );
  return events(...parts);
}

// ---- Local commands (F.7, F.8) ----

/** `/clear`: conversation_reset, two title events and init of the NEW session, result num_turns 0. */
export function clearCommand(
  c: DslContext,
  o: { prompt: string; newSessionId: string; title?: string | null },
): FixtureEvent[] {
  const next: DslContext = { ...c, sessionId: o.newSessionId };
  const resetId = c.ids.uuid();
  const steps: Step[] = [
    state(c, 'running'),
    lifecycle(c, o.prompt, 'queued'),
    lifecycle(c, o.prompt, 'started'),
    frame(
      c,
      msg({
        type: 'conversation_reset',
        new_conversation_id: resetId,
        trigger: 'clear',
        user_message_uuid: o.prompt,
        timestamp: c.timestamp(),
      }),
      { uuid: resetId },
    ),
  ];
  const title = o.title ?? null;
  if (title !== null) {
    steps.push(
      frame(next, system(0, 'session_title_changed', { title })),
      frame(next, system(0, 'session_title_changed', { title })),
    );
  }
  steps.push(
    initFrame(next),
    resultFrame(next, o.prompt, {
      num_turns: 0,
      total_cost_usd: 0,
      result: '',
      terminal_reason: undefined,
      duration_api_ms: 0,
    }),
    lifecycle(next, o.prompt, 'completed'),
    state(next, 'idle'),
  );
  return toEvents(steps, c.stepMs);
}

/** `/rename X`: session_title_changed, synthetic local-command answer, result num_turns 0. */
export function renameCommand(c: DslContext, o: { prompt: string; title: string }): FixtureEvent[] {
  const text = `Session renamed to: ${o.title}`;
  return toEvents(
    [
      state(c, 'running'),
      lifecycle(c, o.prompt, 'queued'),
      lifecycle(c, o.prompt, 'started'),
      frame(c, system(0, 'session_title_changed', { title: o.title })),
      initFrame(c),
      frame(
        c,
        assistant(
          0,
          c.ids.uuid(),
          { type: 'text', text },
          {
            timestamp: c.timestamp(),
            local_command_run: { command: 'rename', args: o.title },
            local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
          },
          '<synthetic>',
        ),
      ),
      resultFrame(c, o.prompt, {
        num_turns: 0,
        result: text,
        local_command: 'rename',
        terminal_reason: undefined,
        duration_api_ms: 0,
      }),
      lifecycle(c, o.prompt, 'completed'),
      state(c, 'idle'),
    ],
    c.stepMs,
  );
}

// ---- Failures ----

/** Start failure (C.5, R0-26): zeroed error result with `startup_failure_reason`. */
export function startupFailure(c: DslContext, o: { reason: string; prompt?: string | null }): FixtureEvent[] {
  return toEvents([
    resultFrame(c, o.prompt ?? null, {
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      usage: usage(0, 0, 0, 0),
      modelUsage: {},
      errors: [`startup failed: ${o.reason}`],
      startup_failure_reason: o.reason,
      terminal_reason: undefined,
      result: undefined,
    }),
  ]);
}

/** A turn that fails with `assistant.error` (synthetic API error message, C.5). */
export function assistantErrorTurn(
  c: DslContext,
  o: { prompt: string | null; error?: string; text?: string },
): FixtureEvent[] {
  const text = o.text ?? 'Invalid API key · Please run /login';
  return events(
    turnOpen(c, o.prompt),
    assistantMessage(c, [textBlock(text)], {
      streamed: false,
      model: '<synthetic>',
      error: o.error ?? 'authentication_failed',
    }),
    turnClose(c, o.prompt, { result: { is_error: true, result: text, api_error_status: 401 } }),
  );
}

/** Spontaneous process end (crash, expected:false). */
export function crash(code = 1): FixtureEvent[] {
  return toEvents([['exit', { pid: null, code, signal: null }]]);
}

/** Exit gate: waits for close(), then exit{expected:true, code}. */
export function closeGate(code = 0): FixtureEvent[] {
  return toEvents([['exit', { pid: null, code, signal: null, msSinceClose: 900 }]]);
}
