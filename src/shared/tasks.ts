import {
  RUNNING_TASK_ITEMS_MAX,
  RUNNING_TASK_LABEL_MAX,
  type BackgroundTask,
  type RunningTaskItem,
  type RunningTasks,
  type TaskInfo,
  type TaskKind,
  type ToolCallItem,
  type ToolCallStatus,
  type TranscriptItem,
} from './model';

/**
 * The task model of a session (WP-55, ADR-149/150), pure: the background tasks of `detail` plus the
 * tasks of tool calls (Agent, background Bash) and of `task_notification` items, one row per
 * `taskId`. A task counts as finished as soon as any source says so (status outside the open set,
 * `endedAt`, or its tool call no longer running) – stale "running" data never resurrects it.
 *
 * One model for the task panel, the counter of the header's "Tasks" button (CR3-02, ADR-158) and,
 * since WP-71, the server's `SessionSummary.runningTasks` (sidebar): all count the running rows of
 * `buildTaskRows(…)`. Left out: ambient background tasks. Left out as part of their agent: a
 * subagent's foreground shell (`local_bash`, `isBackgrounded: false`, WP61-06). Running – and so
 * stoppable – only what the server's `session.stopTask` accepts: a listed background task or a tool
 * call `running`/`background` (CR3-07; `pending` has not started).
 */

const OPEN_STATUSES: ReadonlySet<string> = new Set(['started', 'running', 'pending']);
/** Tool call states whose task runs (= `hasStoppableTask` of the server). */
const LIVE_TOOL_STATUSES: ReadonlySet<ToolCallStatus> = new Set<ToolCallStatus>(['running', 'background']);

export type { TaskKind } from './model';

export interface TaskRow {
  taskId: string;
  kind: TaskKind;
  /** As reported (`local_agent`, …); shown for kind `other`. */
  taskType: string | null;
  description: string;
  subagentType: string | null;
  /** Open set: started|running|completed|failed|stopped|killed|… */
  status: string;
  running: boolean;
  startedAt: string | null;
  endedAt: string | null;
  usage: TaskInfo['usage'];
  summary: string | null;
  outputFile: string | null;
}

export function taskKind(taskType: string | null): TaskKind {
  switch (taskType) {
    case 'local_agent':
    case 'remote_agent':
      return 'agent';
    case 'local_bash':
      return 'bash';
    case 'local_workflow':
      return 'workflow';
    default:
      return 'other';
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

function explicitlyEnded(row: Pick<TaskRow, 'status' | 'endedAt'>): boolean {
  return row.endedAt !== null || !OPEN_STATUSES.has(row.status);
}

/** A tool call in a state whose task runs: `running` or `background` (not `pending`, CR3-07). */
export function isLiveToolStatus(status: ToolCallStatus): boolean {
  return LIVE_TOOL_STATUSES.has(status);
}

/** The task is open: no end time, status in the open set (unknown statuses count as finished). */
function taskOpen(task: TaskInfo): boolean {
  return task.endedAt === null && OPEN_STATUSES.has(task.status);
}

/**
 * The task of this tool call runs – and the server's `session.stopTask` takes it (tool call
 * `running`/`background`, task open). One rule for the task panel and the agent card (CR3-07).
 */
export function isToolCallTaskLive(item: Pick<ToolCallItem, 'status' | 'task'>): boolean {
  return item.task !== null && isLiveToolStatus(item.status) && taskOpen(item.task);
}

function fromInfo(task: TaskInfo, live: boolean): TaskRow {
  return {
    taskId: task.taskId,
    kind: taskKind(task.taskType),
    taskType: task.taskType,
    description: task.description,
    subagentType: task.subagentType,
    status: task.status,
    running: live && taskOpen(task),
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    usage: task.usage,
    summary: nonEmpty(task.summary),
    outputFile: nonEmpty(task.outputFile),
  };
}

/** Newer facts win; a finished state is never undone by a stale running one. */
function merge(current: TaskRow, next: TaskRow): TaskRow {
  const keepFinished = !current.running && next.running;
  const taskType = next.taskType ?? current.taskType;
  return {
    taskId: current.taskId,
    kind: taskKind(taskType),
    taskType,
    description: next.description === '' ? current.description : next.description,
    subagentType: next.subagentType ?? current.subagentType,
    status: keepFinished ? current.status : next.status,
    running: keepFinished ? false : next.running,
    startedAt: next.startedAt ?? current.startedAt,
    endedAt: keepFinished ? current.endedAt : (next.endedAt ?? current.endedAt),
    usage: next.usage ?? current.usage,
    summary: next.summary ?? current.summary,
    outputFile: next.outputFile ?? current.outputFile,
  };
}

/** The item carries task facts (a tool call with a task, a task notification). */
export function isTaskSourceItem(item: TranscriptItem): boolean {
  return (
    (item.kind === 'tool_call' && item.task !== null) ||
    (item.kind === 'system' && item.event === 'task_notification')
  );
}

/** The items that carry task facts (tool calls with a task, task notifications), in order. */
export function taskSourceItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.filter(isTaskSourceItem);
}

function startOf(row: TaskRow): number {
  const ms = row.startedAt === null ? Number.NaN : Date.parse(row.startedAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function endOf(row: TaskRow): number {
  const ms = row.endedAt === null ? Number.NaN : Date.parse(row.endedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** A subagent's shell in the foreground: it runs inside the agent's turn (WP61-06). */
function isSubagentForegroundShell(item: TranscriptItem, task: TaskInfo): boolean {
  return item.parentToolUseId !== null && taskKind(task.taskType) === 'bash' && !task.isBackgrounded;
}

/**
 * All task rows: running ones first (oldest start first), then finished ones (latest end first).
 * Ambient background tasks (no user activity) and subagents' foreground shells are left out.
 */
export function buildTaskRows(
  sources: readonly TranscriptItem[],
  background: readonly BackgroundTask[],
): TaskRow[] {
  const rows = new Map<string, TaskRow>();
  /** Foreground shells of subagents – unless any source says the task runs in the background. */
  const nested = new Set<string>();
  const backgrounded = new Set<string>();
  const put = (row: TaskRow) => {
    const current = rows.get(row.taskId);
    rows.set(row.taskId, current === undefined ? row : merge(current, row));
  };
  const note = (item: TranscriptItem, task: TaskInfo) => {
    if (isSubagentForegroundShell(item, task)) nested.add(task.taskId);
    if (task.isBackgrounded) backgrounded.add(task.taskId);
  };
  for (const item of sources) {
    if (item.kind === 'tool_call' && item.task !== null) {
      note(item, item.task);
      put(fromInfo(item.task, isLiveToolStatus(item.status)));
    } else if (item.kind === 'system' && item.event === 'task_notification') {
      note(item, item.task);
      put(fromInfo(item.task, true));
    }
  }
  const ambient = new Set<string>();
  for (const task of background) {
    if (task.ambient) {
      ambient.add(task.taskId);
      continue;
    }
    // Listed by the server: a background task in any case.
    backgrounded.add(task.taskId);
    const current = rows.get(task.taskId);
    if (current === undefined) {
      rows.set(task.taskId, {
        taskId: task.taskId,
        kind: taskKind(task.taskType),
        taskType: task.taskType,
        description: task.description,
        subagentType: task.subagentType,
        status: 'running',
        running: true,
        startedAt: null,
        endedAt: null,
        usage: null,
        summary: null,
        outputFile: null,
      });
    } else {
      rows.set(task.taskId, {
        ...current,
        // Listed by the server as running: only an explicit end (status, endedAt) says otherwise –
        // a tool call that already returned (async agent) does not.
        running: current.running || !explicitlyEnded(current),
        kind: taskKind(current.taskType ?? task.taskType),
        taskType: current.taskType ?? task.taskType,
        description: current.description === '' ? task.description : current.description,
        subagentType: current.subagentType ?? task.subagentType,
      });
    }
  }
  const all = [...rows.values()].filter(
    (row) => !ambient.has(row.taskId) && !(nested.has(row.taskId) && !backgrounded.has(row.taskId)),
  );
  const running = all.filter((row) => row.running).sort((a, b) => startOf(a) - startOf(b));
  const finished = all.filter((row) => !row.running).sort((a, b) => endOf(b) - endOf(a));
  return [...running, ...finished];
}

/** Running rows – the one count of the task panel and the header's "Tasks" button (CR3-02). */
export function runningTaskCount(rows: readonly TaskRow[]): number {
  let count = 0;
  for (const row of rows) if (row.running) count += 1;
  return count;
}

/** Running tasks of a session: `runningTaskCount(buildTaskRows(…))`. */
export function countRunningTasks(
  sources: readonly TranscriptItem[],
  background: readonly BackgroundTask[],
): number {
  return runningTaskCount(buildTaskRows(sources, background));
}

/** WP-71: running rows by kind – agents, shells, the rest (workflows, unknown kinds). */
export type RunningTaskCounts = Pick<RunningTasks, 'agents' | 'shells' | 'other'>;

export const NO_RUNNING_TASKS: RunningTaskCounts = { agents: 0, shells: 0, other: 0 };

export function runningTaskCounts(rows: readonly TaskRow[]): RunningTaskCounts {
  let agents = 0;
  let shells = 0;
  let other = 0;
  for (const row of rows) {
    if (!row.running) continue;
    if (row.kind === 'agent') agents += 1;
    else if (row.kind === 'bash') shells += 1;
    else other += 1;
  }
  return { agents, shells, other };
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** WP-71: one running row for the tooltip – agents with their progress summary, else the description. */
export function runningTaskItem(row: TaskRow): RunningTaskItem {
  const text = row.kind === 'agent' && row.summary !== null ? row.summary : row.description;
  return {
    kind: row.kind,
    subagentType: row.subagentType === null ? null : clip(row.subagentType, 100),
    label: clip(text, RUNNING_TASK_LABEL_MAX),
  };
}

/**
 * WP-71: `SessionSummary.runningTasks` from the rows – the counts by kind plus the first
 * `RUNNING_TASK_ITEMS_MAX` running tasks (the rows' order: oldest start first); null = nothing runs.
 */
export function summarizeRunningTasks(rows: readonly TaskRow[]): RunningTasks | null {
  const counts = runningTaskCounts(rows);
  if (counts.agents + counts.shells + counts.other === 0) return null;
  const items: RunningTaskItem[] = [];
  for (const row of rows) {
    if (items.length >= RUNNING_TASK_ITEMS_MAX) break;
    if (row.running) items.push(runningTaskItem(row));
  }
  return { ...counts, items };
}

/** WP-71: all running tasks of a summary (0 for null). */
export function runningTaskTotal(tasks: RunningTaskCounts | null): number {
  return tasks === null ? 0 : tasks.agents + tasks.shells + tasks.other;
}
