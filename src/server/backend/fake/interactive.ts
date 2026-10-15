/**
 * Interactive dev scenario (WP-13 §3.3; default of `createFakeBackend`, `pnpm dev`, E2E): answers
 * every prompt by keyword (first word, case-insensitive) – `fake:bash`, `fake:edit`,
 * `fake:question`, `fake:plan`, `fake:subagent`, `fake:parallel`, `fake:slow`, `fake:compact`,
 * `fake:ratelimit`, `fake:error`, `fake:crash`, `fake:held`, `/rename X`, `/clear`; anything else
 * gets a thought plus a streamed "Echo: …". Decisions really wait for the engine; interrupt() and
 * prompts with priority 'now' abort the running turn (F.9/F.10, simplified).
 */
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parsePermissionMode } from '@shared/common';
import { system as systemFrame, msg } from '../../sessions/normalizer/synthetic/build';
import type { OutgoingPrompt } from '../types';
import { TurnInterrupted, promptText } from './common';
import {
  assistantErrorTurn,
  assistantMessage,
  clearCommand,
  dslContext,
  events,
  frame,
  interruptEpilogue,
  renameCommand,
  startupFailure,
  streamedText,
  subagentEnd,
  subagentLaunch,
  textBlock,
  thinkingContent,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  toolUseContent,
  turnClose,
  turnOpen,
  type DslContext,
} from './dsl';
import type { FakeScenario, FakeScriptContext } from './types';

/** Per turn: what an interrupt epilogue needs. */
interface Turn {
  prompt: string;
  toolUseId: string | null;
}

/** Thinking + answer stream of ~1 s at speed 1. */
const ANSWER_STEP_MS = 40;

function firstWords(text: string, count = 5): string {
  const words = text.trim().split(/\s+/).slice(0, count).join(' ');
  return words.length > 60 ? `${words.slice(0, 59)}…` : words;
}

function contextFor(ctx: FakeScriptContext, sessionId: string): DslContext {
  return dslContext({
    sessionId,
    ids: ctx.ids,
    model: ctx.state.model,
    permissionMode: ctx.state.permissionMode,
    cwd: ctx.req.cwd,
    timestamp: () => ctx.now().toISOString(),
    stepMs: ANSWER_STEP_MS,
  });
}

const CANCEL_DENY = (result: PermissionResult): boolean =>
  result.behavior === 'deny' && result.interrupt === true;

/** Asks canUseTool like the CLI (requires_action → gate → running). */
async function ask(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  options: Record<string, unknown>,
): Promise<PermissionResult> {
  turn.toolUseId = toolUseId;
  await ctx.play(toEvents([frame(c, systemFrame(0, 'session_state_changed', { state: 'requires_action' }))]));
  const result = await ctx.canUseTool(toolName, input, {
    displayName: toolName,
    toolUseID: toolUseId,
    requestId: ctx.ids.uuid(),
    ...options,
  });
  if (!CANCEL_DENY(result)) {
    await ctx.play(toEvents([frame(c, systemFrame(0, 'session_state_changed', { state: 'running' }))]));
  }
  return result;
}

/** deny with interrupt: the CLI ends the turn as aborted (F.3, permissions#236). */
async function abortedByDecision(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  await ctx.play(interruptEpilogue(c, { prompt: turn.prompt, toolUseId: turn.toolUseId }));
}

async function echo(ctx: FakeScriptContext, c: DslContext, turn: Turn, text: string): Promise<void> {
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      assistantMessage(
        c,
        [thinkingContent(`The user wrote: ${firstWords(text, 8)}`), textBlock(`Echo: ${text}`)],
        { chunks: 10 },
      ),
      turnClose(c, turn.prompt, { result: { result: `Echo: ${text}` } }),
    ),
  );
}

async function bash(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const input = { command: 'mkdir -p fake-dir && ls -1', description: 'Create fake-dir and list the folder' };
  const suggestions: PermissionUpdate[] = [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: input.command }],
      behavior: 'allow',
      destination: 'localSettings',
    },
    { type: 'addDirectories', directories: [ctx.req.cwd], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toolUseBlock(c, 'Bash', input, { toolUseId, thinking: 'I will run the command.' }),
    ),
  );
  const result = await ask(ctx, c, turn, 'Bash', input, toolUseId, {
    suggestions,
    description: input.description,
    decisionReason: 'This command requires approval',
    decisionReasonType: 'other',
  });
  if (CANCEL_DENY(result)) return abortedByDecision(ctx, c, turn);
  if (result.behavior === 'deny') {
    await ctx.play(
      events(
        toolResultMessage(c, toolUseId, result.message, {
          isError: true,
          toolUseResult: `Error: ${result.message}`,
        }),
        streamedText(c, 'Okay, I did not run the command.'),
        turnClose(c, turn.prompt, { result: { result: 'Okay, I did not run the command.' } }),
      ),
    );
    return;
  }
  turn.toolUseId = null;
  await ctx.play(
    events(
      toolResultMessage(c, toolUseId, 'fake-dir\nnotes.txt', {
        toolUseResult: {
          stdout: 'fake-dir\nnotes.txt',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      }),
      streamedText(c, 'Done: the folder fake-dir exists now.'),
      turnClose(c, turn.prompt, { result: { result: 'Done: the folder fake-dir exists now.' } }),
    ),
  );
}

async function edit(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const filePath = `${ctx.req.cwd}\\fake-notes.txt`;
  const input = { file_path: filePath, content: 'alpha\n' };
  await ctx.play(events(turnOpen(c, turn.prompt), toolUseBlock(c, 'Write', input, { toolUseId })));
  const result = await ask(ctx, c, turn, 'Write', input, toolUseId, {
    suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    description: 'fake-notes.txt',
  });
  if (CANCEL_DENY(result)) return abortedByDecision(ctx, c, turn);
  const ok = result.behavior === 'allow';
  const answer = ok ? 'The file fake-notes.txt was written.' : 'Okay, I left the file alone.';
  turn.toolUseId = null;
  await ctx.play(
    events(
      ok
        ? toolResultMessage(c, toolUseId, `File created successfully at: ${filePath}`, {
            toolUseResult: {
              type: 'create',
              filePath,
              content: input.content,
              structuredPatch: [],
              originalFile: null,
            },
          })
        : toolResultMessage(c, toolUseId, result.message, { isError: true }),
      streamedText(c, answer),
      turnClose(c, turn.prompt, { result: { result: answer } }),
    ),
  );
}

const QUESTION = 'Which color should the button be?';

async function question(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const input = {
    questions: [
      {
        question: QUESTION,
        header: 'Color',
        options: [
          {
            label: 'Red',
            description: 'A bold, high-contrast red button.',
            preview: '```\n[  Submit  ]  <- red\n```',
          },
          {
            label: 'Blue',
            description: 'A calm, neutral blue button.',
            preview: '```\n[  Submit  ]  <- blue\n```',
          },
        ],
        multiSelect: false,
      },
    ],
  };
  await ctx.play(events(turnOpen(c, turn.prompt), toolUseBlock(c, 'AskUserQuestion', input, { toolUseId })));
  const result = await ask(ctx, c, turn, 'AskUserQuestion', input, toolUseId, {
    requiresUserInteraction: true,
  });
  if (CANCEL_DENY(result)) return abortedByDecision(ctx, c, turn);
  turn.toolUseId = null;
  if (result.behavior === 'deny') {
    await ctx.play(
      events(
        toolResultMessage(c, toolUseId, result.message, { isError: true }),
        streamedText(c, 'Okay, no answer then.'),
        turnClose(c, turn.prompt, { result: { result: 'Okay, no answer then.' } }),
      ),
    );
    return;
  }
  const answers = z.record(z.string(), z.string()).safeParse(result.updatedInput?.answers);
  const chosen = (answers.success ? answers.data[QUESTION] : undefined) ?? '?';
  const answer = `You chose: ${chosen}`;
  await ctx.play(
    events(
      toolResultMessage(c, toolUseId, `The user answered: "${QUESTION}"="${chosen}".`, {
        toolUseResult: result.updatedInput,
      }),
      streamedText(c, answer),
      turnClose(c, turn.prompt, { result: { result: answer } }),
    ),
  );
}

function setModeOf(result: PermissionResult): string | null {
  if (result.behavior !== 'allow') return null;
  const setMode = (result.updatedPermissions ?? []).find((u) => u.type === 'setMode');
  return setMode?.type === 'setMode' ? setMode.mode : null;
}

async function plan(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const planFilePath = 'C:\\Users\\user\\.claude\\plans\\fake-plan.md';
  let text = '## Plan\n- Create `hello.txt` with the content `hello`.\n- Reply with exactly: IMPLEMENTED\n';
  await ctx.play(turnOpen(c, turn.prompt));
  for (let version = 1; version <= 5; version += 1) {
    // Plan mode: the plan file is written without a permission card (F.6).
    const writeId = ctx.ids.toolUseId();
    await ctx.play(
      events(
        toolUseBlock(
          c,
          'Write',
          { file_path: planFilePath, content: text },
          { toolUseId: writeId, thinking: 'Writing the plan.' },
        ),
        toolResultMessage(c, writeId, `File created successfully at: ${planFilePath}`),
      ),
    );
    const exitId = ctx.ids.toolUseId();
    const input = { plan: text, planFilePath };
    await ctx.play(toolUseBlock(c, 'ExitPlanMode', input, { toolUseId: exitId }));
    const result = await ask(ctx, c, turn, 'ExitPlanMode', input, exitId, { requiresUserInteraction: true });
    if (CANCEL_DENY(result)) return abortedByDecision(ctx, c, turn);
    if (result.behavior === 'deny') {
      // Revise (F.6): the feedback goes back to Claude, a new version follows.
      await ctx.play(
        toolResultMessage(c, exitId, result.message, {
          isError: true,
          toolUseResult: `Error: ${result.message}`,
        }),
      );
      text = `${text}- Revision ${String(version)}: ${firstWords(result.message, 12)}\n`;
      continue;
    }
    const mode = parsePermissionMode(setModeOf(result)) ?? 'default';
    ctx.state.permissionMode = mode;
    const approved = typeof result.updatedInput?.plan === 'string' ? result.updatedInput.plan : text;
    const implementId = ctx.ids.toolUseId();
    turn.toolUseId = null;
    await ctx.play(
      events(
        toEvents([frame(c, systemFrame(0, 'status', { status: null, permissionMode: mode }))]),
        toolResultMessage(
          c,
          exitId,
          `User has approved your plan. You can now start coding.\n\n## Approved Plan:\n${approved}`,
          {
            toolUseResult: {
              plan: approved,
              isAgent: false,
              filePath: planFilePath,
              planWasEdited: approved !== text,
            },
          },
        ),
        toolUseBlock(
          c,
          'Write',
          { file_path: `${ctx.req.cwd}\\hello.txt`, content: 'hello' },
          { toolUseId: implementId },
        ),
        toolResultMessage(c, implementId, `File created successfully at: ${ctx.req.cwd}\\hello.txt`),
        streamedText(c, 'IMPLEMENTED'),
        turnClose(c, turn.prompt, { result: { result: 'IMPLEMENTED' } }),
      ),
    );
    return;
  }
  await ctx.play(events(streamedText(c, 'Giving up after five plan revisions.'), turnClose(c, turn.prompt)));
}

async function subagent(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const toolUseId = ctx.ids.toolUseId();
  const taskId = `task_${toolUseId}`;
  const spec = {
    toolUseId,
    taskId,
    description: 'Fake ping',
    prompt: 'Reply with exactly the word PONG.',
    reply: 'PONG',
  };
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      subagentLaunch(c, spec),
      streamedText(c, 'The subagent is still running; I will report once it is done.'),
      // F.11: the first result comes while the agent still runs – no idle yet.
      turnClose(c, turn.prompt, { result: { result: 'The subagent is still running.' }, idle: false }),
      assistantMessage(c, [thinkingContent('Simple task.'), textBlock('PONG')], {
        parentToolUseId: toolUseId,
      }),
      subagentEnd(c, { toolUseId, taskId, summary: 'PONG' }),
      turnOpen(c, null),
      streamedText(c, 'SUBAGENT SAID PONG'),
      turnClose(c, null, { result: { result: 'SUBAGENT SAID PONG' } }),
    ),
  );
}

async function parallel(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const agents = [1, 2].map((n) => {
    const toolUseId = ctx.ids.toolUseId();
    return {
      n,
      toolUseId,
      taskId: `task_${toolUseId}`,
      bashId: ctx.ids.toolUseId(),
      description: `Fake worker ${String(n)}`,
      prompt: `Run fake step ${String(n)}`,
      reply: `worker ${String(n)} done`,
    };
  });
  await ctx.play(turnOpen(c, turn.prompt));
  for (const agent of agents) await ctx.play(subagentLaunch(c, agent));
  await ctx.play(
    events(
      streamedText(c, 'Two workers run in the background.'),
      turnClose(c, turn.prompt, { result: { result: 'Two workers run in the background.' }, idle: false }),
    ),
  );
  // Both subagents ask at the same time (A.6): several open decisions.
  const results = await Promise.all(
    agents.map(async (agent) => {
      const input = {
        command: `echo fake-step-${String(agent.n)}`,
        description: `Fake step ${String(agent.n)}`,
      };
      await ctx.play(
        assistantMessage(c, [toolUseContent('Bash', input, agent.bashId)], {
          parentToolUseId: agent.toolUseId,
          streamed: false,
        }),
      );
      const result = await ctx.canUseTool('Bash', input, {
        displayName: 'Bash',
        toolUseID: agent.bashId,
        requestId: ctx.ids.uuid(),
        agentID: agent.taskId,
        description: input.description,
      });
      return { agent, result };
    }),
  );
  for (const { agent, result } of results) {
    const ok = result.behavior === 'allow';
    await ctx.play(
      events(
        toolResultMessage(c, agent.bashId, ok ? `fake-step-${String(agent.n)}` : 'Denied by the user.', {
          isError: !ok,
          parentToolUseId: agent.toolUseId,
        }),
        assistantMessage(c, [textBlock(agent.reply)], { parentToolUseId: agent.toolUseId }),
      ),
    );
  }
  await ctx.play(
    subagentEnd(c, {
      toolUseId: agents[0]?.toolUseId ?? '',
      taskId: agents[0]?.taskId ?? '',
      summary: 'done',
      remaining: agents.slice(1),
    }),
  );
  await ctx.play(
    subagentEnd(c, {
      toolUseId: agents[1]?.toolUseId ?? '',
      taskId: agents[1]?.taskId ?? '',
      summary: 'done',
    }),
  );
  await ctx.play(
    events(
      turnOpen(c, null),
      streamedText(c, 'Both workers are done.'),
      turnClose(c, null, { result: { result: 'Both workers are done.' } }),
    ),
  );
}

async function slow(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const text = Array.from({ length: 100 }, (_, i) => `Line ${String(i + 1)} of a slow answer.`).join('\n');
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      assistantMessage(c, [textBlock(text)], { chunks: 100, stepMs: 200 }),
      turnClose(c, turn.prompt, { result: { result: 'Line 100 of a slow answer.' } }),
    ),
  );
}

async function compact(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toEvents(
        [
          frame(c, systemFrame(0, 'status', { status: 'compacting' })),
          frame(
            c,
            systemFrame(0, 'compact_boundary', {
              compact_metadata: { trigger: 'manual', pre_tokens: 160_000, post_tokens: 30_000 },
            }),
          ),
          frame(c, systemFrame(0, 'status', { status: null })),
        ],
        300,
      ),
      streamedText(c, 'Compacted.'),
      turnClose(c, turn.prompt, { result: { result: 'Compacted.' } }),
    ),
  );
}

async function ratelimit(ctx: FakeScriptContext, c: DslContext, turn: Turn): Promise<void> {
  const resetsAt = Math.floor(ctx.now().getTime() / 1000) + 3600;
  const rateLimit = (info: Record<string, unknown>) =>
    frame(c, msg({ type: 'rate_limit_event', rate_limit_info: info }));
  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      toEvents([
        rateLimit({
          status: 'allowed_warning',
          resetsAt,
          rateLimitType: 'five_hour',
          utilization: 0.85,
          unifiedWindows: { five_hour: { utilization: 0.85, resetsAt } },
        }),
      ]),
      streamedText(c, 'Almost at the limit.'),
      toEvents([rateLimit({ status: 'rejected', resetsAt, rateLimitType: 'five_hour', utilization: 1 })]),
      turnClose(c, turn.prompt, { result: { is_error: true, result: 'Rate limit reached.' } }),
    ),
  );
}

async function handle(
  ctx: FakeScriptContext,
  prompt: OutgoingPrompt,
  sessionId: string,
  turn: Turn,
): Promise<string> {
  const c = contextFor(ctx, sessionId);
  const text = promptText(prompt).trim();
  const keyword = (text.split(/\s+/)[0] ?? '').toLowerCase();
  switch (keyword) {
    case 'fake:bash':
    case 'fake:permission':
      await bash(ctx, c, turn);
      break;
    case 'fake:edit':
      await edit(ctx, c, turn);
      break;
    case 'fake:question':
      await question(ctx, c, turn);
      break;
    case 'fake:plan':
      await plan(ctx, c, turn);
      break;
    case 'fake:subagent':
      await subagent(ctx, c, turn);
      break;
    case 'fake:parallel':
      await parallel(ctx, c, turn);
      break;
    case 'fake:slow':
      await slow(ctx, c, turn);
      break;
    case 'fake:compact':
    case '/compact':
      await compact(ctx, c, turn);
      break;
    case 'fake:ratelimit':
      await ratelimit(ctx, c, turn);
      break;
    case 'fake:error':
      await ctx.play(assistantErrorTurn(c, { prompt: turn.prompt, error: 'authentication_failed' }));
      break;
    case 'fake:crash':
      await ctx.play(
        events(turnOpen(c, turn.prompt), toolUseBlock(c, 'Bash', { command: 'echo crash' }).slice(0, 4)),
      );
      return ctx.crash(1);
    case 'fake:held':
      await ctx.play(startupFailure(c, { reason: 'session_held_by_background', prompt: turn.prompt }));
      return ctx.crash(1);
    case '/rename': {
      const title = text.slice('/rename'.length).trim() || 'Fake session';
      await ctx.play(renameCommand(c, { prompt: turn.prompt, title }));
      ctx.history.rename(sessionId, title);
      break;
    }
    case '/clear': {
      const next = ctx.ids.uuid();
      const info = ctx.history.info(sessionId);
      const title =
        typeof info === 'object' &&
        info !== null &&
        'customTitle' in info &&
        typeof info.customTitle === 'string'
          ? info.customTitle
          : null;
      await ctx.play(clearCommand(c, { prompt: turn.prompt, newSessionId: next, title }));
      // F.7: the custom title is taken over by the new session.
      if (title !== null) ctx.history.rename(next, title);
      return next;
    }
    default:
      await echo(ctx, c, turn, text);
  }
  return sessionId;
}

async function runInteractive(ctx: FakeScriptContext): Promise<void> {
  let sessionId = ctx.sessionId;
  let titled = false;
  for (;;) {
    const prompt = await ctx.nextInput();
    const turn: Turn = { prompt: prompt.uuid, toolUseId: null };
    const text = promptText(prompt).trim();
    try {
      sessionId = await handle(ctx, prompt, sessionId, turn);
    } catch (error) {
      if (!(error instanceof TurnInterrupted)) throw error;
      const c = contextFor(ctx, sessionId);
      await ctx.play(
        interruptEpilogue(c, { prompt: turn.prompt, toolUseId: turn.toolUseId, reason: error.reason }),
      );
    }
    ctx.state.turns += 1;
    if (!titled && text !== '' && !text.startsWith('/')) {
      // The CLI's AI title (§3.5.8): visible through getSessionInfo().summary.
      ctx.history.setAiTitle(sessionId, `Fake: ${firstWords(text)}`);
      titled = true;
    }
  }
}

export function interactiveScenario(): FakeScenario {
  return { kind: 'script', name: 'interactive', run: runInteractive };
}
