import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import type { BackgroundTask, TaskInfo, TodoList, ToolCallItem, TranscriptItem } from '@shared/model';
import {
  sampleDetail,
  sampleId,
  sampleItems,
  sampleSessionSnapshot,
  sampleSummary,
  sampleSystemItems,
} from '@shared/samples';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';

/**
 * Fixtures of the tasks feature (tests and playground; never imported by production code): task
 * infos, the tool calls and notifications that carry them, and a FakeHost scenario with one
 * session. Times are relative to `now`, so the 10-minute window works with the real clock.
 */

export const TASKS_ENTRY: EntryId = sampleId('en', 551);
export const TASKS_SESSION_KEY = makeSessionKey(LOCAL_HOST_ID, TASKS_ENTRY);

const MINUTE = 60_000;

export function ago(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

export function taskInfo(taskId: string, patch: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId,
    taskType: 'local_agent',
    status: 'running',
    description: taskId,
    subagentType: null,
    isBackgrounded: true,
    summary: null,
    usage: null,
    startedAt: null,
    endedAt: null,
    outputFile: null,
    ...patch,
  };
}

export function taskTool(order: number, task: TaskInfo, patch: Partial<ToolCallItem> = {}): ToolCallItem {
  const bash = task.taskType === 'local_bash';
  return sampleItems.toolCall({
    id: `msg_task_${task.taskId}:0`,
    messageId: `msg_task_${task.taskId}`,
    blockIndex: 0,
    order,
    toolUseId: `toolu_task_${task.taskId}`,
    toolName: bash ? 'Bash' : 'Agent',
    input: bash
      ? { command: 'pnpm test --watch', description: task.description, run_in_background: true }
      : {
          description: task.description,
          prompt: task.description,
          subagent_type: task.subagentType ?? 'general-purpose',
        },
    status: task.endedAt === null ? 'background' : 'done',
    result: null,
    task,
    ...patch,
  });
}

export function taskNotification(order: number, task: TaskInfo): TranscriptItem {
  return sampleSystemItems.task_notification({ id: `note_${task.taskId}`, order, task });
}

export function backgroundTask(taskId: string, patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId,
    taskType: 'local_agent',
    description: taskId,
    subagentType: null,
    parentTaskId: null,
    ambient: false,
    ...patch,
  };
}

/** A session with every kind of row: agent, Bash and workflow running, finished ones, expired, ambient. */
export function mixedTaskSession(now: number): {
  items: TranscriptItem[];
  backgroundTasks: BackgroundTask[];
} {
  const agent = taskInfo('task_agent', {
    description: 'Review the sync tests',
    subagentType: 'Explore',
    startedAt: ago(now, 3 * MINUTE),
    summary: 'Read 4 of 7 test files; one flaky timeout in hub.test.ts',
    usage: { totalTokens: 18_200, toolUses: 9, durationMs: 0 },
    outputFile: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_agent.output',
  });
  const bash = taskInfo('task_bash', {
    taskType: 'local_bash',
    description: 'pnpm test --watch',
    startedAt: ago(now, 2 * MINUTE),
    outputFile: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_bash.output',
  });
  const done = taskInfo('task_done', {
    description: 'Find usages of applySeqOps',
    status: 'completed',
    startedAt: ago(now, 6 * MINUTE),
    endedAt: ago(now, 2 * MINUTE),
    summary: 'Used in 3 files',
    usage: { totalTokens: 22_609, toolUses: 2, durationMs: 9_400 },
  });
  const failed = taskInfo('task_failed', {
    taskType: 'local_workflow',
    description: 'Nightly checks',
    status: 'failed',
    startedAt: ago(now, 5 * MINUTE),
    endedAt: ago(now, MINUTE),
  });
  const expired = taskInfo('task_expired', {
    description: 'An old task',
    status: 'completed',
    startedAt: ago(now, 30 * MINUTE),
    endedAt: ago(now, 11 * MINUTE),
  });
  return {
    items: [
      sampleItems.userMessage({ id: 'px:tasks:prompt', order: 1 }),
      taskTool(2, expired),
      taskTool(3, done),
      taskTool(4, agent),
      taskTool(5, bash),
      taskNotification(6, failed),
    ],
    backgroundTasks: [
      backgroundTask('task_agent', { subagentType: 'Explore' }),
      backgroundTask('task_bash', { taskType: 'local_bash' }),
      backgroundTask('task_deploy', { taskType: 'local_workflow', description: 'Deploy preview' }),
      backgroundTask('task_ambient', { ambient: true, description: 'Ambient indexer' }),
    ],
  };
}

export interface TasksSessionSetup {
  entryId?: EntryId;
  items?: TranscriptItem[];
  backgroundTasks?: BackgroundTask[];
  todos?: TodoList | null;
}

/** Starts the "empty" scenario with tasks sessions (FakeHost + real HostConnection); default entry TASKS_ENTRY. */
export function startTasksScenario(...sessions: TasksSessionSetup[]): RunningScenario {
  const running = startScenario('empty', { select: null });
  for (const session of sessions) {
    const entryId = session.entryId ?? TASKS_ENTRY;
    running.host.addSession(
      sampleSessionSnapshot({
        entryId,
        seq: 0,
        items: session.items ?? [],
        detail: sampleDetail({
          entryId,
          backgroundTasks: session.backgroundTasks ?? [],
          todos: session.todos ?? null,
        }),
      }),
    );
    running.host.upsertSummary(sampleSummary({ entryId, title: 'Tasks' }));
  }
  return running;
}
