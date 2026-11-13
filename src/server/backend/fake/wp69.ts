/**
 * Fake building blocks of WP-69, used by the interactive scenario (interactive.ts, phase3.ts):
 * - subagent transcripts: the CLI writes a subagent's whole conversation to `agent-<id>.jsonl`
 *   (prompt, thinking, texts, tool calls) while the live stream carries only its tool calls (§0).
 *   These builders make such transcript-only messages (raw `SessionMessage` shapes) and put them into
 *   the FakeHistoryStore under the agent id, so `fake:subagent` and `fake:background` have a
 *   transcript that grows while they run;
 * - `fake:hooks`: hook runs as `includeHookEvents` reports them (CLI 2.1.323, §0) – UserPromptSubmit,
 *   PreToolUse/PostToolUse of a `Read`, a blocking PreToolUse of a `Write` (exit 2, its `tool_result`
 *   `is_error`) and Stop; one `hook_started` + one `hook_response` per run.
 */
import { system } from '../../sessions/normalizer/synthetic/build';
import type { FixtureEvent } from '../fixture';
import {
  events,
  frame,
  streamedText,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
} from './dsl';
import type { Turn } from './turn';
import type { FakeScriptContext } from './types';

// ---- subagent transcripts ----

/** `fake:subagent`: pause between two transcript steps (× speed, ≤ maxDelayMs; none at speed 0). */
export const FAKE_SUBAGENT_STEP_MS = 1_500;

/** One work step of a fake subagent: thinking + a tool call, then its result. */
export interface FakeSubagentStep {
  thinking: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
}

/** `fake:subagent`: the steps its transcript grows by (one per FAKE_SUBAGENT_STEP_MS). */
export const FAKE_SUBAGENT_STEPS: readonly FakeSubagentStep[] = [
  {
    thinking: 'First I look at the project layout.',
    tool: 'Glob',
    input: { pattern: '**/*.md' },
    result: 'README.md\nnotes.md',
  },
  {
    thinking: 'The notes may say what PONG means here.',
    tool: 'Read',
    input: { file_path: 'notes.md' },
    result: '1\t# Notes\n2\tPING → PONG',
  },
  {
    thinking: 'Nothing else is needed.',
    tool: 'Grep',
    input: { pattern: 'PONG', path: '.' },
    result: 'notes.md:2:PING → PONG',
  },
];

/** `fake:background`: the transcript steps at its launch, halfway and before the end. */
export const FAKE_BACKGROUND_STEPS: readonly FakeSubagentStep[] = [
  {
    thinking: 'List the files first.',
    tool: 'Bash',
    input: { command: 'dir /b', description: 'List the project files' },
    result: 'README.md\nnotes.md\napp.ts',
  },
  {
    thinking: 'Now write the summary.',
    tool: 'Write',
    input: { file_path: 'summary.md', content: '# Summary\nThree files, no open problems.' },
    result: 'File created successfully at: summary.md',
  },
];

/** The subagent's prompt – the first line of its transcript (the Agent input). */
export function subagentPromptMessage(c: DslContext, agentToolUseId: string, prompt: string): unknown {
  return {
    type: 'user',
    uuid: c.ids.uuid(),
    message: { role: 'user', content: prompt },
    parent_tool_use_id: agentToolUseId,
    timestamp: c.timestamp(),
  };
}

/** One step: assistant (thinking + tool_use), then the user message with its tool_result. */
export function subagentStepMessages(c: DslContext, agentToolUseId: string, step: FakeSubagentStep): unknown[] {
  const toolUseId = c.ids.toolUseId();
  return [
    {
      type: 'assistant',
      uuid: c.ids.uuid(),
      message: {
        id: c.ids.messageId(),
        type: 'message',
        role: 'assistant',
        model: c.model,
        content: [
          { type: 'thinking', thinking: step.thinking, signature: '' },
          { type: 'tool_use', id: toolUseId, name: step.tool, input: step.input },
        ],
      },
      parent_tool_use_id: agentToolUseId,
      timestamp: c.timestamp(),
    },
    {
      type: 'user',
      uuid: c.ids.uuid(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: step.result }] },
      parent_tool_use_id: agentToolUseId,
      timestamp: c.timestamp(),
    },
  ];
}

/** The subagent's final text (transcript only; `fake:subagent` plays its answer in the stream). */
export function subagentTextMessage(c: DslContext, agentToolUseId: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid: c.ids.uuid(),
    message: {
      id: c.ids.messageId(),
      type: 'message',
      role: 'assistant',
      model: c.model,
      content: [{ type: 'text', text }],
    },
    parent_tool_use_id: agentToolUseId,
    timestamp: c.timestamp(),
  };
}

/** Appends transcript-only messages to `agent-<agentId>` of the session. */
export function recordSubagent(ctx: FakeScriptContext, sessionId: string, agentId: string, messages: readonly unknown[]): void {
  for (const message of messages) ctx.history.recordSubagent(sessionId, agentId, message);
}

// ---- fake:hooks ----

/** `fake:hooks`: what the blocking PreToolUse hook prints (stdout = stderr = output, like the CLI). */
export const FAKE_HOOK_BLOCK_OUTPUT = 'Writing is blocked in this project\n';
/** `fake:hooks`: the hook command as the CLI quotes it in the tool_result. */
export const FAKE_HOOK_BLOCK_COMMAND = 'powershell -NoProfile -File .claude\\hooks\\no-write.ps1';
export const FAKE_HOOKS_ANSWER = 'The notes were read; writing hello.txt was blocked by a hook.';

interface HookRun {
  name: string;
  event: string;
  outcome?: 'success' | 'error';
  exitCode?: number;
  output?: string;
}

/** One hook run: `hook_started`, then `hook_response` (same hook_id). */
function hookRun(c: DslContext, run: HookRun): FixtureEvent[] {
  const hookId = c.ids.uuid();
  const output = run.output ?? '';
  return toEvents(
    [
      frame(c, system(0, 'hook_started', { hook_id: hookId, hook_name: run.name, hook_event: run.event })),
      frame(
        c,
        system(0, 'hook_response', {
          hook_id: hookId,
          hook_name: run.name,
          hook_event: run.event,
          output,
          stdout: output,
          stderr: run.outcome === 'error' ? output : '',
          exit_code: run.exitCode ?? 0,
          outcome: run.outcome ?? 'success',
        }),
      ),
    ],
    c.stepMs,
  );
}

/** `fake:hooks`: four successful hook runs and one blocking PreToolUse (exit 2) around a Read and a Write. */
export async function hooks(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const readId = ctx.ids.toolUseId();
  const writeId = ctx.ids.toolUseId();
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      hookRun(c, { name: 'UserPromptSubmit', event: 'UserPromptSubmit' }),
      toolUseBlock(c, 'Read', { file_path: 'notes.md' }, { toolUseId: readId, thinking: 'Read the notes first.' }),
      hookRun(c, { name: 'PreToolUse:Read', event: 'PreToolUse' }),
      toolResultMessage(c, readId, '1\t# Notes', {
        toolUseResult: { type: 'text', file: { filePath: 'notes.md', content: '# Notes', numLines: 1 } },
      }),
      hookRun(c, { name: 'PostToolUse:Read', event: 'PostToolUse' }),
      toolUseBlock(c, 'Write', { file_path: 'hello.txt', content: 'hello' }, { toolUseId: writeId }),
      hookRun(c, {
        name: 'PreToolUse:Write',
        event: 'PreToolUse',
        outcome: 'error',
        exitCode: 2,
        output: FAKE_HOOK_BLOCK_OUTPUT,
      }),
      toolResultMessage(
        c,
        writeId,
        `PreToolUse:Write hook error: [${FAKE_HOOK_BLOCK_COMMAND}]: ${FAKE_HOOK_BLOCK_OUTPUT}`,
        { isError: true, toolUseResult: `Error: PreToolUse:Write hook error: [${FAKE_HOOK_BLOCK_COMMAND}]` },
      ),
      streamedText(c, FAKE_HOOKS_ANSWER),
      hookRun(c, { name: 'Stop', event: 'Stop' }),
      turnClose(c, turn.prompt, { result: { result: FAKE_HOOKS_ANSWER } }),
    ),
  );
}
