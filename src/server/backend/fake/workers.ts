/**
 * WP-71 `fake:workers`: two background agents and a background shell at the same time – "what
 * runs where" (sidebar counters and pulse, the header's task button, the task panel). The shell
 * ends after `FAKE_WORKERS_SHELL_MS`, the agents after `FAKE_WORKERS_AGENT_MS` (× speed, not capped
 * by maxDelayMs); `stopTask` ends each one earlier. Every end sends `background_tasks_changed` with
 * the tasks still running; the last one plays the follow-up turn. `idle` only afterwards (the
 * session holds it back while a task runs, like the CLI with background agents).
 */
import { system } from '../../sessions/normalizer/synthetic/build';
import type { FixtureEvent } from '../fixture';
import {
  events,
  frame,
  streamedText,
  subagentLaunch,
  taskProgress,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
  type DslContext,
} from './dsl';
import { contextFor, type Turn } from './turn';
import type { FakeScriptContext } from './types';

/** The shell ends first, then agent 1, then agent 2 (× speed). */
export const FAKE_WORKERS_SHELL_MS = 6_000;
export const FAKE_WORKERS_AGENT_MS = [9_000, 12_000] as const;
export const FAKE_WORKERS_STARTED = 'Two agents and a shell are working in the background.';
export const FAKE_WORKERS_DONE = 'All background work has finished.';
export const FAKE_WORKERS_SHELL = { command: 'pnpm dev', description: 'Start the dev server' } as const;
export const FAKE_WORKERS_AGENTS = [
  { description: 'Review the API module', summary: 'Reading the API handlers' },
  { description: 'Write the migration notes', summary: 'Collecting the schema changes' },
] as const;

interface Worker {
  taskId: string;
  toolUseId: string;
  kind: 'agent' | 'bash';
  description: string;
  ms: number;
  /** The agent's answer / the shell's end text. */
  summary: string;
}

/** Raw messages of DSL events (all `message` kind). */
function messagesOf(list: readonly FixtureEvent[]): unknown[] {
  return list.flatMap((event) => (event.kind === 'message' ? [event.payload] : []));
}

/** `system/background_tasks_changed` (REPLACE) with the given workers – agents and shells. */
function backgroundList(c: DslContext, workers: readonly Worker[]) {
  return frame(
    c,
    system(0, 'background_tasks_changed', {
      tasks: workers.map((w) =>
        w.kind === 'agent'
          ? {
              task_id: w.taskId,
              task_type: 'local_agent',
              subagent_type: 'general-purpose',
              description: w.description,
            }
          : { task_id: w.taskId, task_type: 'local_bash', description: w.description },
      ),
    }),
  );
}

/** End of one worker: (agents) task_updated, task_notification, the list of the rest. */
function endOf(
  c: DslContext,
  worker: Worker,
  status: 'completed' | 'stopped',
  rest: readonly Worker[],
  endTime: number,
): FixtureEvent[] {
  const summary = status === 'stopped' ? `${worker.description} was stopped.` : worker.summary;
  return toEvents(
    [
      ...(worker.kind === 'agent'
        ? [
            frame(
              c,
              system(0, 'task_updated', {
                task_id: worker.taskId,
                patch: { status: status === 'stopped' ? 'killed' : status, end_time: endTime },
              }),
            ),
          ]
        : []),
      frame(
        c,
        system(0, 'task_notification', {
          task_id: worker.taskId,
          tool_use_id: worker.toolUseId,
          status,
          output_file: '',
          summary,
        }),
      ),
      backgroundList(c, rest),
    ],
    c.stepMs,
  );
}

export async function workers(
  ctx: FakeScriptContext,
  c: DslContext,
  turn: Turn,
  sessionId: string,
): Promise<void> {
  const agents: Worker[] = FAKE_WORKERS_AGENTS.map((spec, i) => {
    const toolUseId = ctx.ids.toolUseId();
    return {
      taskId: `task_${toolUseId}`,
      toolUseId,
      kind: 'agent',
      description: spec.description,
      ms: FAKE_WORKERS_AGENT_MS[i] ?? FAKE_WORKERS_SHELL_MS,
      summary: `${spec.description}: done.`,
    };
  });
  const shellToolUseId = ctx.ids.toolUseId();
  const shell: Worker = {
    taskId: `b${shellToolUseId.replace(/[^a-z0-9]/gi, '').slice(-8)}`,
    toolUseId: shellToolUseId,
    kind: 'bash',
    description: FAKE_WORKERS_SHELL.description,
    ms: FAKE_WORKERS_SHELL_MS,
    summary: `${FAKE_WORKERS_SHELL.description} finished`,
  };
  const all = [...agents, shell];
  const running = new Set(all.map((w) => w.taskId));

  await ctx.play(
    events(
      turnOpen(c, turn.prompt),
      ...agents.map((agent) =>
        subagentLaunch(c, {
          toolUseId: agent.toolUseId,
          taskId: agent.taskId,
          description: agent.description,
          prompt: `${agent.description}.`,
          reply: agent.summary,
          runInBackground: true,
        }),
      ),
      toolUseBlock(
        c,
        'Bash',
        { ...FAKE_WORKERS_SHELL, run_in_background: true },
        { toolUseId: shell.toolUseId },
      ),
      toEvents([
        frame(
          c,
          system(0, 'task_started', {
            task_id: shell.taskId,
            tool_use_id: shell.toolUseId,
            description: shell.description,
            task_type: 'local_bash',
            is_backgrounded: true,
          }),
        ),
      ]),
      toolResultMessage(c, shell.toolUseId, `Command running in background with ID: ${shell.taskId}`, {
        toolUseResult: {
          stdout: '',
          stderr: '',
          interrupted: false,
          isImage: false,
          backgroundTaskId: shell.taskId,
        },
      }),
      toEvents([backgroundList(c, all)]),
      ...agents.map((agent, i) =>
        taskProgress(c, {
          taskId: agent.taskId,
          toolUseId: agent.toolUseId,
          activity: `Running ${agent.description}`,
          summary: FAKE_WORKERS_AGENTS[i]?.summary ?? agent.description,
          usage: { totalTokens: 1_200, toolUses: 1, durationMs: 1_000 },
        }),
      ),
      streamedText(c, FAKE_WORKERS_STARTED),
    ),
  );

  const finish = (worker: Worker, status: 'completed' | 'stopped'): unknown[] => {
    running.delete(worker.taskId);
    const rest = all.filter((w) => running.has(w.taskId));
    return messagesOf(endOf(c, worker, status, rest, ctx.now().getTime()));
  };
  for (const worker of all) {
    ctx.startTask({
      taskId: worker.taskId,
      run: async (control) => {
        await control.wait(worker.ms);
        control.emit(finish(worker, 'completed'));
        control.finish('completed');
        if (running.size > 0) return;
        // The last one: the CLI answers in a turn of its own (F.11); state of now (model, mode).
        const now = contextFor(ctx, sessionId);
        await control.betweenTurns(
          events(
            turnOpen(now, null),
            streamedText(now, FAKE_WORKERS_DONE),
            turnClose(now, null, { result: { result: FAKE_WORKERS_DONE } }),
          ),
        );
      },
      stopped: () => finish(worker, 'stopped'),
    });
  }
  // Result now; idle only once every worker has ended (the session holds it back, F.11).
  await ctx.play(turnClose(c, turn.prompt, { result: { result: FAKE_WORKERS_STARTED } }));
}
