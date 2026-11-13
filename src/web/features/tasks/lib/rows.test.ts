import { describe, expect, it } from 'vitest';
import type { TaskInfo, ToolCallItem, TranscriptItem } from '@shared/model';
import { sampleItems, sampleSystemItems, sampleTime } from '@shared/samples';
import { buildTaskRows, type TaskRow } from '@shared/tasks';
import { RECENT_TASK_MS, canStopTask, finishedDuration, visibleTaskRows } from './rows';

/** Panel helpers; the row model itself is tested in `@shared/tasks.test.ts` (CR3-02, WP-71). */

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

const ids = (rows: readonly TaskRow[]) =>
  rows.map((row) => `${row.taskId}:${row.running ? 'run' : row.status}`);

describe('task panel helpers', () => {
  it('a pending tool call offers no Stop – the server would answer TASK_NOT_FOUND (CR3-07)', () => {
    const [pending] = buildTaskRows([toolWith(info('p'), { status: 'pending' })], []);
    expect(pending === undefined ? true : canStopTask(pending)).toBe(false);
    const [running] = buildTaskRows([toolWith(info('r'), { status: 'running' })], []);
    expect(running === undefined ? false : canStopTask(running)).toBe(true);
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
});
