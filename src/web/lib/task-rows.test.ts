import { describe, expect, it } from 'vitest';
import type { TaskInfo, ToolCallItem } from '@shared/model';
import { sampleDetail, sampleItems, sampleSessionSnapshot, sampleTime } from '@shared/samples';
import { viewStateFromSnapshot } from '@shared/sync';
import * as shared from '@shared/tasks';
import { buildTaskRows, countRunningTasks, isToolCallTaskLive, selectTaskSources } from './task-rows';

/** The row model itself is tested in `@shared/tasks.test.ts` (WP-71: one model for server and web). */

function toolWith(task: TaskInfo): ToolCallItem {
  return sampleItems.toolCall({
    id: `tool:${task.taskId}`,
    toolUseId: `toolu_${task.taskId}`,
    toolName: 'Agent',
    status: 'background',
    result: null,
    task,
  });
}

const task: TaskInfo = {
  taskId: 'a',
  taskType: 'local_agent',
  status: 'running',
  description: 'Task a',
  subagentType: null,
  isBackgrounded: true,
  summary: null,
  usage: null,
  startedAt: sampleTime(1),
  endedAt: null,
  outputFile: null,
};

describe('task-rows (web)', () => {
  it('re-exports the shared model unchanged (existing importers keep working)', () => {
    expect(buildTaskRows).toBe(shared.buildTaskRows);
    expect(countRunningTasks).toBe(shared.countRunningTasks);
    expect(isToolCallTaskLive).toBe(shared.isToolCallTaskLive);
  });

  it('selectTaskSources: cached per items array, equal content for equal task items', () => {
    const view = viewStateFromSnapshot(
      sampleSessionSnapshot({
        items: [sampleItems.userMessage(), toolWith(task)],
        detail: sampleDetail(),
      }),
    );
    const first = selectTaskSources(view);
    expect(first.map((item) => item.id)).toEqual(['tool:a']);
    expect(selectTaskSources(view)).toBe(first);
    const next = { ...view, items: [...view.items, sampleItems.assistantText({ order: 99 })] };
    expect(selectTaskSources(next)).not.toBe(first);
    expect(selectTaskSources(next)).toEqual(first);
  });
});
