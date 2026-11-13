import { windowsPathKey } from '@shared/paths';
import type { ToolCallItem, TranscriptItem } from '@shared/model';
import { getToolRenderer } from '../renderers';

/**
 * WP-65 §1.2: what happened in a session since the user last looked (`lastSeenAt`, held when the
 * transcript opens) – computed from the loaded items by their timestamps: turns (without the
 * synthetic ones of `/rename`, `/clear`), changed files (Write/Edit/MultiEdit/NotebookEdit that
 * succeeded, in order, each once), answered and open decisions, the cost of those turns and the
 * first new top-level item (target of "To the first new message"). Nothing without a new turn.
 */
export interface SinceFacts {
  turns: number;
  /** Paths as the tools named them (relative ones resolve against the cwd in the link). */
  files: string[];
  answered: number;
  open: number;
  /** Sum of `costUsdTurn` of the new turns; null when none reported a cost. */
  costUsd: number | null;
  /** First new top-level item (by `order`). */
  firstItemId: string | null;
}

const CHANGING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function changedFile(item: ToolCallItem): string | null {
  if (!CHANGING_TOOLS.has(item.toolName) || item.status !== 'done') return null;
  return getToolRenderer(item.toolName).file?.(item)?.path ?? null;
}

export function sinceFacts(items: readonly TranscriptItem[], since: string): SinceFacts | null {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return null;
  const facts: SinceFacts = { turns: 0, files: [], answered: 0, open: 0, costUsd: null, firstItemId: null };
  const seenFiles = new Set<string>();
  let firstOrder = Infinity;
  for (const item of items) {
    if (!(Date.parse(item.at) > sinceMs)) continue;
    if (item.parentToolUseId === null && item.order < firstOrder) {
      firstOrder = item.order;
      facts.firstItemId = item.id;
    }
    if (item.kind === 'turn_result') {
      if (item.synthetic) continue;
      facts.turns += 1;
      if (item.costUsdTurn !== null) facts.costUsd = (facts.costUsd ?? 0) + item.costUsdTurn;
    } else if (item.kind === 'tool_call') {
      const file = changedFile(item);
      if (file !== null && !seenFiles.has(windowsPathKey(file))) {
        seenFiles.add(windowsPathKey(file));
        facts.files.push(file);
      }
      const decision = item.decision;
      if (decision !== null) {
        if (decision.outcome === null) {
          if (item.status === 'awaiting_decision') facts.open += 1;
        } else if (decision.outcome.type !== 'expired') {
          facts.answered += 1;
        }
      }
    }
  }
  return facts.turns === 0 ? null : facts;
}
