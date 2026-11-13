import { describe, expect, it } from 'vitest';
import {
  RUNNING_TASK_ITEMS_MAX,
  RUNNING_TASK_LABEL_MAX,
  runningTasksSchema,
  type BackgroundTask,
  type TaskInfo,
  type ToolCallItem,
  type TranscriptItem,
} from './model';
import { sampleItems, sampleSystemItems, sampleTime } from './samples';
import {
  buildTaskRows,
  countRunningTasks,
  isLiveToolStatus,
  isTaskSourceItem,
  isToolCallTaskLive,
  runningTaskCount,
  runningTaskCounts,
  runningTaskItem,
  runningTaskTotal,
  summarizeRunningTasks,
  taskKind,
  taskSourceItems,
  type TaskRow,
} from './tasks';

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

  it('a pending tool call is not running – the server only stops running/background (CR3-07)', () => {
    const [pending] = buildTaskRows([toolWith(info('p'), { status: 'pending' })], []);
    expect(pending?.running).toBe(false);
    // Listed by the server as a background task: stoppable there, so here too.
    expect(buildTaskRows([toolWith(info('q'), { status: 'pending' })], [background('q')])[0]?.running).toBe(
      true,
    );
    expect(buildTaskRows([toolWith(info('r'), { status: 'running' })], [])[0]?.running).toBe(true);
  });

  it("a subagent's foreground shell is part of the agent, not a task of its own (WP61-06)", () => {
    const agent = toolWith(info('agent', { startedAt: sampleTime(1) }));
    const shell = toolWith(info('shell', { taskType: 'local_bash', isBackgrounded: false }), {
      status: 'running',
      parentToolUseId: agent.toolUseId,
    });
    expect(ids(buildTaskRows([agent, shell], [background('agent')]))).toEqual(['agent:run']);
    // A shell the subagent sent to the background is a task of its own.
    const backgrounded = toolWith(info('bg', { taskType: 'local_bash', startedAt: sampleTime(2) }), {
      parentToolUseId: agent.toolUseId,
    });
    expect(ids(buildTaskRows([agent, backgrounded], [background('agent')]))).toEqual(['agent:run', 'bg:run']);
    // The main agent's long foreground shell stays (the server can stop it).
    const main = toolWith(
      info('main', { taskType: 'local_bash', isBackgrounded: false, startedAt: sampleTime(3) }),
      {
        status: 'running',
      },
    );
    expect(ids(buildTaskRows([agent, main], [background('agent')]))).toEqual(['agent:run', 'main:run']);
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

  it('isToolCallTaskLive: running/background with an open task – the rule of panel and agent card (CR3-07)', () => {
    expect(isToolCallTaskLive(toolWith(info('a'), { status: 'background' }))).toBe(true);
    expect(isToolCallTaskLive(toolWith(info('a'), { status: 'running' }))).toBe(true);
    expect(isToolCallTaskLive(toolWith(info('a'), { status: 'pending' }))).toBe(false);
    expect(isToolCallTaskLive(toolWith(info('a'), { status: 'done' }))).toBe(false);
    expect(isToolCallTaskLive(toolWith(info('a', { status: 'stopped' }), { status: 'background' }))).toBe(
      false,
    );
    expect(isToolCallTaskLive(toolWith(info('a', { endedAt: sampleTime(9) }), { status: 'running' }))).toBe(
      false,
    );
    expect(isToolCallTaskLive({ status: 'running', task: null })).toBe(false);
    expect(isLiveToolStatus('pending')).toBe(false);
    expect(isLiveToolStatus('background')).toBe(true);
  });

  it('runningTaskCount / countRunningTasks: the running rows – one count for panel and header (CR3-02)', () => {
    const items = [
      toolWith(info('agent', { startedAt: sampleTime(1) })),
      toolWith(info('done', { status: 'completed', endedAt: sampleTime(9) }), { status: 'done' }),
      toolWith(info('pending'), { status: 'pending' }),
    ];
    const listed = [
      background('agent'),
      background('bash', { taskType: 'local_bash' }),
      background('x', { ambient: true }),
    ];
    const rows = buildTaskRows(taskSourceItems(items), listed);
    expect(runningTaskCount(rows)).toBe(2);
    expect(countRunningTasks(taskSourceItems(items), listed)).toBe(2);
    expect(countRunningTasks([], [])).toBe(0);
  });

  it('isTaskSourceItem: tool calls with a task and task notifications', () => {
    expect(isTaskSourceItem(toolWith(info('a')))).toBe(true);
    expect(isTaskSourceItem(notification(info('b')))).toBe(true);
    expect(isTaskSourceItem(sampleItems.toolCall())).toBe(false);
    expect(isTaskSourceItem(sampleItems.assistantText())).toBe(false);
  });
});

describe('running tasks by kind (WP-71, SessionSummary.runningTasks)', () => {
  const twoAgentsAndAShell = () =>
    buildTaskRows(
      taskSourceItems([
        toolWith(
          info('a1', {
            startedAt: sampleTime(1),
            summary: 'Reading the project files',
            subagentType: 'Explore',
          }),
        ),
        toolWith(info('a2', { startedAt: sampleTime(2), summary: '' })),
        toolWith(
          info('sh', {
            taskType: 'local_bash',
            startedAt: sampleTime(3),
            description: 'Start the dev server',
          }),
          {
            status: 'background',
          },
        ),
        toolWith(info('done', { status: 'completed', endedAt: sampleTime(9) }), { status: 'done' }),
      ]),
      [
        background('a1'),
        background('a2'),
        background('wf', { taskType: 'local_workflow', description: 'Nightly' }),
        background('amb', { ambient: true }),
      ],
    );

  it('counts running rows: agents, shells, the rest – the same rows as the panel', () => {
    const rows = twoAgentsAndAShell();
    expect(runningTaskCounts(rows)).toEqual({ agents: 2, shells: 1, other: 1 });
    expect(runningTaskCount(rows)).toBe(4);
    expect(runningTaskCounts([])).toEqual({ agents: 0, shells: 0, other: 0 });
  });

  it('summarizes counts and the first running tasks (oldest first); null when nothing runs', () => {
    const summary = summarizeRunningTasks(twoAgentsAndAShell());
    expect(summary).toEqual({
      agents: 2,
      shells: 1,
      other: 1,
      items: [
        { kind: 'agent', subagentType: 'Explore', label: 'Reading the project files' },
        // An agent without a summary: its description.
        { kind: 'agent', subagentType: null, label: 'Task a2' },
        { kind: 'bash', subagentType: null, label: 'Start the dev server' },
        // Listed only, start unknown: last.
        { kind: 'workflow', subagentType: null, label: 'Nightly' },
      ],
    });
    expect(runningTasksSchema.parse(summary)).toEqual(summary);
    expect(summarizeRunningTasks([])).toBeNull();
    expect(
      summarizeRunningTasks(buildTaskRows([notification(info('x', { status: 'completed' }))], [])),
    ).toBeNull();
    expect(runningTaskTotal(summary)).toBe(4);
    expect(runningTaskTotal(null)).toBe(0);
  });

  it(`names at most ${String(RUNNING_TASK_ITEMS_MAX)} tasks and clips long labels`, () => {
    const listed = Array.from({ length: 8 }, (_, i) =>
      background(`t${String(i)}`, { taskType: 'local_bash' }),
    );
    const summary = summarizeRunningTasks(buildTaskRows([], listed));
    expect(summary?.shells).toBe(8);
    expect(summary?.items).toHaveLength(RUNNING_TASK_ITEMS_MAX);
    const [row] = buildTaskRows([], [background('l')]);
    if (row === undefined) throw new Error('no row');
    const long = runningTaskItem({
      ...row,
      description: `  ${'word '.repeat(60)}  `,
      subagentType: 'x'.repeat(150),
    });
    expect(long.label).toHaveLength(RUNNING_TASK_LABEL_MAX);
    expect(long.label.endsWith('…')).toBe(true);
    expect(long.subagentType).toHaveLength(100);
  });
});
