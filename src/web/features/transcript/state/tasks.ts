import { parseSessionKey } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSummarySelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';

/**
 * Session facts the transcript's file links and task controls need (WP-55): the cwd (relative paths
 * of tool inputs and search hits) and stopping one background task (`session.stopTask`, ADR-149).
 */

const selectCwd = (summary: SessionSummary): string | null => summary.cwd;

/** The session's working directory, null while its summary is unknown. */
export function useSessionCwd(sessionKey: string | null): string | null {
  return useSummarySelector(sessionKey, selectCwd, null);
}

/**
 * Stops one background task. An error shows as a notice – except `TASK_NOT_FOUND`: the task
 * finished meanwhile, which is what the user wanted anyway. Resolves whether the command succeeded.
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
      showErrorNotice(payload, { sessionKey, id: `transcript-stop-task-${taskId}` });
    }
    return false;
  }
}
