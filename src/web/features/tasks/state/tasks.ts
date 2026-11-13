import { useMemo } from 'react';
import { parseSessionKey } from '@shared/common';
import type { BackgroundTask, TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { buildTaskRows, type TaskRow } from '@shared/tasks';
import { selectTaskSources } from '@web/lib/task-rows';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSessionSelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';

/**
 * Store access of the task panel (WP-55): the task rows of a session (re-rendered only when a
 * task-bearing item or the background list changes – not on every text delta) and stopping tasks
 * (`session.stopTask`, ADR-149). The rows come from `@shared/tasks`, the model the header's
 * counter shares (CR3-02). The todo list: `state/todos.ts`.
 */

const EMPTY_ITEMS: readonly TranscriptItem[] = Object.freeze([]);
const EMPTY_BACKGROUND: readonly BackgroundTask[] = Object.freeze([]);

const selectBackground = (view: SessionViewState): readonly BackgroundTask[] => view.detail.backgroundTasks;

/** All task rows of the session (running first); the 10-minute window is the caller's (clock). */
export function useTaskRows(sessionKey: string): readonly TaskRow[] {
  // Shallow comparison: the same task items → the same array → no new rows.
  const sources = useSessionSelector(sessionKey, selectTaskSources, EMPTY_ITEMS);
  const background = useSessionSelector(sessionKey, selectBackground, EMPTY_BACKGROUND);
  return useMemo(() => buildTaskRows(sources, background), [sources, background]);
}

/**
 * Stops one task. An error shows as a notice – except `TASK_NOT_FOUND`: the task finished
 * meanwhile, which is what the user wanted. Resolves whether the command succeeded.
 */
export async function stopTask(sessionKey: string, taskId: string): Promise<boolean> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return false;
  try {
    await sendCommand(sessionKey, { name: 'session.stopTask', entryId: parsed.entryId, taskId });
    return true;
  } catch (error: unknown) {
    const payload = errorPayloadOf(error);
    if (payload.code !== 'TASK_NOT_FOUND') {
      showErrorNotice(payload, { sessionKey, id: `tasks-stop-${taskId}` });
    }
    return false;
  }
}

/**
 * "Stop all": one task after the other (no burst of interrupts at the CLI); `onProgress` after
 * each. A failed stop does not end the series. Resolves the number of tasks stopped.
 */
export async function stopTasks(
  sessionKey: string,
  taskIds: readonly string[],
  onProgress?: (done: number) => void,
): Promise<number> {
  let stopped = 0;
  for (const [index, taskId] of taskIds.entries()) {
    if (await stopTask(sessionKey, taskId)) stopped++;
    onProgress?.(index + 1);
  }
  return stopped;
}
