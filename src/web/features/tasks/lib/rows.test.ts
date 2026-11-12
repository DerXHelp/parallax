import { describe, expect, it } from 'vitest';
import type { BackgroundTask, TaskInfo, ToolCallItem, TranscriptItem } from '@shared/model';
import { sampleItems, sampleSystemItems, sampleTime, sampleTodoList } from '@shared/samples';
import {
  RECENT_TASK_MS,
  buildTaskRows,
  canStopTask,
  finishedDuration,
  taskKind,
  taskSourceItems,
  todoProgress,
  visibleTaskRows,
  type TaskRow,
} from './rows';

function info(taskId: string, patch: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId,
    taskType: 'local_agent',
    status: 'running',
    description: `Task ${taskId}`,
    subagentType: null,
    isBackgrounded: true,
    summary: null,
    usage: null,
    startedAt: sampleTime(1),
    endedAt: null,
    outputFile: null,
    ...patch,
  };
}

function toolWith(task: TaskInfo, patch: Partial<ToolCallItem> = {}): ToolCallItem {
  return sampleItems.toolCall({
    id: `tool:${task.taskId}`,
    toolUseId: `toolu_${task.taskId}`,
    toolName: task.taskType === 'local_bash' ? 'Bash' : 'Agent',
    status: 'background',
    result: null,
    task,
    ...patch,
  });
}

function notification(task: TaskInfo): TranscriptItem {
  return sampleSystemItems.task_notification({ id: `note:${task.taskId}`, task });
}

function background(taskId: string, patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId,
    taskType: 'local_agent',
    description: `Background ${taskId}`,
    subagentType: null,
    parentTaskId: null,
    ambient: false,
    ...patch,
  };
}

const ids = (rows: readonly TaskRow[]) =>
  rows.map((row) => `${row.taskId}:${row.running ? 'run' : row.status}`);

describe('buildTaskRows', () => {
  it('merges tool calls, notifications and the background list into one row per task', () => {
    const items = [
      sampleItems.userMessage(),
      toolWith(
        info('a', {
          startedAt: sampleTime(5),
          summary: 'Reading',
          usage: { totalTokens: 10, toolUses: 1, durationMs: 1 },
        }),
      ),
      sampleItems.assistantText(),
      toolWith(info('b', { taskType: 'local_bash', startedAt: sampleTime(2) })),
    ];
    const rows = buildTaskRows(taskSourceItems(items), [
      background('a', { subagentType: 'Explore' }),
      background('c', { taskType: 'local_workflow', description: 'Nightly' }),
    ]);
    expect(ids(rows)).toEqual(['b:run', 'a:run', 'c:run']);
    expect(rows[1]).toMatchObject({
      kind: 'agent',
      summary: 'Reading',
      subagentType: 'Explore',
      description: 'Task a',
    });
    expect(rows[0]?.kind).toBe('bash');
    expect(rows[2]).toMatchObject({ kind: 'workflow', description: 'Nightly', startedAt: null, usage: null });
  });

  it('a finished state wins over stale running data (notification after the tool call, either order)', () => {
    const ended = info('a', {
      status: 'completed',
      endedAt: sampleTime(30),
      summary: 'Done',
      outputFile: 'C:\\t\\a.output',
    });
    const rows = buildTaskRows([toolWith(info('a')), notification(ended)], [background('a')]);
    expect(ids(rows)).toEqual(['a:completed']);
    expect(rows[0]).toMatchObject({
      summary: 'Done',
      outputFile: 'C:\\t\\a.output',
      endedAt: sampleTime(30),
    });
    const reversed = buildTaskRows([notification(ended), toolWith(info('a'))], []);
    expect(ids(reversed)).toEqual(['a:completed']);
  });

  it('a tool call that is no longer running ends its task – unless the server still lists it', () => {
    const stale = toolWith(info('a'), { status: 'interrupted' });
    expect(buildTaskRows([stale], [])[0]).toMatchObject({ status: 'running', running: false });
    // Async agent: the tool call returned ("launched"), the task still runs in the background.
    const launched = toolWith(info('b'), { status: 'done' });
    expect(buildTaskRows([launched], [background('b')])[0]?.running).toBe(true);
    // An explicit end is never undone by the list.
    const ended = toolWith(info('c', { status: 'stopped', endedAt: sampleTime(9) }), {
      status: 'interrupted',
    });
    expect(buildTaskRows([ended], [background('c')])[0]?.running).toBe(false);
  });

  it('leaves out ambient background tasks; empty input gives no rows', () => {
    expect(buildTaskRows([], [background('x', { ambient: true })])).toEqual([]);
    expect(buildTaskRows([toolWith(info('x'))], [background('x', { ambient: true })])).toEqual([]);
    expect(buildTaskRows([], [])).toEqual([]);
  });

  it('sorts running by start (oldest first, unknown last), finished by end (latest first)', () => {
    const rows = buildTaskRows(
      [
        toolWith(info('late', { startedAt: sampleTime(9) })),
        toolWith(info('early', { startedAt: sampleTime(1) })),
        notification(info('old', { status: 'failed', endedAt: sampleTime(20) })),
        notification(info('new', { status: 'completed', endedAt: sampleTime(40) })),
      ],
      [background('unknown')],
    );
    expect(ids(rows)).toEqual(['early:run', 'late:run', 'unknown:run', 'new:completed', 'old:failed']);
  });

  it('taskSourceItems keeps only task-bearing items', () => {
    const items = [
      sampleItems.toolCall(),
      toolWith(info('a')),
      sampleItems.thinking(),
      notification(info('b')),
    ];
    expect(taskSourceItems(items).map((item) => item.id)).toEqual(['tool:a', 'note:b']);
  });
});

describe('task helpers', () => {
  it.each([
    ['local_agent', 'agent'],
    ['remote_agent', 'agent'],
    ['local_bash', 'bash'],
    ['local_workflow', 'workflow'],
    ['something_new', 'other'],
    [null, 'other'],
  ] as const)('taskKind(%j) = %s', (type, kind) => {
    expect(taskKind(type)).toBe(kind);
  });

  it('canStopTask: running only; shell commands only with TASK_STOP_BASH', () => {
    const [agent, bash] = buildTaskRows(
      [
        toolWith(info('a', { startedAt: sampleTime(1) })),
        toolWith(info('b', { taskType: 'local_bash', startedAt: sampleTime(2) })),
      ],
      [],
    );
    if (agent === undefined || bash === undefined) throw new Error('rows missing');
    expect(canStopTask(agent)).toBe(true);
    expect(canStopTask(bash)).toBe(true);
    expect(canStopTask(bash, false)).toBe(false);
    expect(canStopTask(agent, false)).toBe(true);
    expect(canStopTask({ ...agent, running: false })).toBe(false);
  });

  it('visibleTaskRows: running always, finished for 10 minutes after their end', () => {
    const end = Date.parse(sampleTime(30));
    const rows = buildTaskRows(
      [toolWith(info('run')), notification(info('done', { status: 'completed', endedAt: sampleTime(30) }))],
      [],
    );
    expect(ids(visibleTaskRows(rows, end + RECENT_TASK_MS))).toEqual(['run:run', 'done:completed']);
    expect(ids(visibleTaskRows(rows, end + RECENT_TASK_MS + 1))).toEqual(['run:run']);
  });

  it('finishedDuration: usage first, else end − start, else null', () => {
    const [withUsage] = buildTaskRows(
      [
        notification(
          info('u', {
            status: 'completed',
            endedAt: sampleTime(30),
            usage: { totalTokens: 1, toolUses: 1, durationMs: 4200 },
          }),
        ),
      ],
      [],
    );
    const [fromTimes] = buildTaskRows(
      [notification(info('t', { status: 'completed', startedAt: sampleTime(10), endedAt: sampleTime(30) }))],
      [],
    );
    const [unknown] = buildTaskRows(
      [notification(info('n', { status: 'completed', startedAt: null, endedAt: sampleTime(30) }))],
      [],
    );
    expect(withUsage === undefined ? null : finishedDuration(withUsage)).toBe(4200);
    expect(fromTimes === undefined ? null : finishedDuration(fromTimes)).toBe(
      Date.parse(sampleTime(30)) - Date.parse(sampleTime(10)),
    );
    expect(unknown === undefined ? 0 : finishedDuration(unknown)).toBeNull();
  });

  it('todoProgress: done/total, the active form, open while not all are done', () => {
    expect(todoProgress(null)).toEqual({ done: 0, total: 0, active: null, open: false });
    expect(todoProgress(sampleTodoList())).toEqual({
      done: 1,
      total: 3,
      active: 'Writing the tests',
      open: true,
    });
    const allDone = sampleTodoList({
      items: sampleTodoList().items.map((item) => ({ ...item, status: 'completed' as const })),
    });
    expect(todoProgress(allDone).open).toBe(false);
    const noActiveForm = sampleTodoList({
      items: [{ id: '0', content: 'Write it', status: 'in_progress', activeForm: null }],
    });
    expect(todoProgress(noActiveForm).active).toBe('Write it');
  });
});
