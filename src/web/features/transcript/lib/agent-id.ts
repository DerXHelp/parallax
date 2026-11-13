import { subagentIdSchema, type ToolCallItem } from '@shared/model';
import { resultText } from './text';
import { readAgentResult } from './tool-input';

/**
 * WP-69: the agent id of an Agent/Task call – the name of its transcript (`agent-<id>.jsonl`,
 * `session.subagentTranscript`). In order: the task (`task_started.task_id`, live and once a task
 * notification named it), the live `tool_use_result.agentId`, the line `agentId: <id>` the CLI
 * writes into the tool result (the only source of a foreground agent imported from the history).
 * Null when none is known yet or the value is not a plain id.
 */
const AGENT_ID_LINE = /\bagentId:\s*([A-Za-z0-9_-]+)/;

function plainId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return subagentIdSchema.safeParse(value).success ? value : null;
}

export function agentIdOf(item: ToolCallItem): string | null {
  const fromTask = plainId(item.task?.taskId);
  if (fromTask !== null) return fromTask;
  const fromResult = plainId(readAgentResult(item.result?.structured ?? null)?.agentId);
  if (fromResult !== null) return fromResult;
  if (item.result === null) return null;
  return plainId(AGENT_ID_LINE.exec(resultText(item).text)?.[1]);
}
