import type { SessionSummary } from '@shared/model';
import type { DisplayStatusKind } from '@shared/status';

/**
 * WP-65 §1.1: the quiet second line of a session (sidebar row, session header) – pure part. While a
 * turn runs: the live sentence (the CLI's `task_summary` with Remote Control, else the running tool
 * call or "thinking"); afterwards the turn summary (the CLI's `post_turn_summary` or Parallax's
 * fallback). The words come from the caller's dictionary (`verb` + `target`); CLI texts stay as sent.
 * Also home of the MCP tool name parser (from the transcript's renderers – the row needs it too).
 */

const MCP_PREFIX = 'mcp__';

/** `mcp__<server>__<tool>` → `{ server, tool }`; null for built-in tools. */
export function parseMcpName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith(MCP_PREFIX)) return null;
  const rest = toolName.slice(MCP_PREFIX.length);
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return null;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}

/** How a running tool reads in the line ("Running: …", "Writing …"); `tool` = "{tool}: {target}". */
export type ActivityVerb = 'run' | 'write' | 'edit' | 'read' | 'search' | 'fetch' | 'agent' | 'tool';

const VERBS: Readonly<Record<string, ActivityVerb>> = {
  Bash: 'run',
  PowerShell: 'run',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Read: 'read',
  Grep: 'search',
  Glob: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
  Agent: 'agent',
  Task: 'agent',
};

export function activityVerb(toolName: string): ActivityVerb {
  return VERBS[toolName] ?? 'tool';
}

export type SessionLine =
  | { kind: 'claude'; text: string; attention: boolean }
  | { kind: 'tool'; verb: ActivityVerb; tool: string; target: string | null; attention: boolean }
  | { kind: 'thinking'; attention: boolean }
  | { kind: 'summary'; text: string; attention: boolean };

/** Kinds that mean "the user has to act" (open decision, waiting resume) or "something failed". */
const ATTENTION: ReadonlySet<DisplayStatusKind> = new Set<DisplayStatusKind>([
  'needs-permission',
  'needs-answer',
  'needs-review',
  'needs-resume',
  'error',
]);

/**
 * The line for a summary and its display status, or null (nothing to say: never ran, archived,
 * external). The live line only while the turn runs; the summary stays until the next turn.
 */
export function sessionLine(
  summary: Pick<SessionSummary, 'activity' | 'turnSummary' | 'archived'>,
  status: DisplayStatusKind,
): SessionLine | null {
  if (summary.archived || status === 'external') return null;
  const attention = ATTENTION.has(status);
  const activity = summary.activity;
  if (activity !== null) {
    if (activity.kind === 'claude') return { kind: 'claude', text: activity.text, attention };
    if (activity.kind === 'thinking') return { kind: 'thinking', attention };
    return { kind: 'tool', verb: activityVerb(activity.tool), tool: activity.tool, target: activity.target, attention };
  }
  const turn = summary.turnSummary;
  if (turn === null) return null;
  return { kind: 'summary', text: turn.text, attention: attention || turn.needsAction };
}
