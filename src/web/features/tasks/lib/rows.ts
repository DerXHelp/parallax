import type { BackgroundTask, TaskInfo, TodoList, TranscriptItem } from '@shared/model';

/**
 * Rows of the task panel (WP-55, ADR-149/150), pure: the background tasks of `detail` plus the
 * tasks of tool calls (Agent, background Bash) and of `task_notification` items, one row per
 * `taskId`. A task counts as finished as soon as any source says so (status outside the open set,
 * `endedAt`, or its tool call no longer running) – stale "running" data never resurrects it.
 */

/** Stop also for background shell commands (`local_bash`) – product switch, on by default. */
export const TASK_STOP_BASH = true;
/** Finished tasks stay visible (greyed out) this long. */
export const RECENT_TASK_MS = 10 * 60_000;

const OPEN_STATUSES: ReadonlySet<string> = new Set(['started', 'running', 'pending']);
/** Tool call states of a call whose task may still run. */
const LIVE_TOOL_STATUSES: ReadonlySet<string> = new Set(['running', 'background', 'pending']);

export type TaskKind = 'agent' | 'bash' | 'workflow' | 'other';

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

/** Can the user stop this row (running; shell commands only while `TASK_STOP_BASH`)? */
export function canStopTask(row: TaskRow, stopBash: boolean = TASK_STOP_BASH): boolean {
  return row.running && (row.kind !== 'bash' || stopBash);
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

function explicitlyEnded(row: Pick<TaskRow, 'status' | 'endedAt'>): boolean {
  return row.endedAt !== null || !OPEN_STATUSES.has(row.status);
}

function fromInfo(task: TaskInfo, live: boolean): TaskRow {
  return {
    taskId: task.taskId,
    kind: taskKind(task.taskType),
    taskType: task.taskType,
    description: task.description,
    subagentType: task.subagentType,
    status: task.status,
    running: live && task.endedAt === null && OPEN_STATUSES.has(task.status),
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

/** The items that carry task facts (tool calls with a task, task notifications), in order. */
export function taskSourceItems(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.filter(
    (item) =>
      (item.kind === 'tool_call' && item.task !== null) ||
      (item.kind === 'system' && item.event === 'task_notification'),
  );
}

function startOf(row: TaskRow): number {
  const ms = row.startedAt === null ? Number.NaN : Date.parse(row.startedAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function endOf(row: TaskRow): number {
  const ms = row.endedAt === null ? Number.NaN : Date.parse(row.endedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * All task rows: running ones first (oldest start first), then finished ones (latest end first).
 * Ambient background tasks (no user activity) are left out.
 */
export function buildTaskRows(
  sources: readonly TranscriptItem[],
  background: readonly BackgroundTask[],
): TaskRow[] {
  const rows = new Map<string, TaskRow>();
  const put = (row: TaskRow) => {
    const current = rows.get(row.taskId);
    rows.set(row.taskId, current === undefined ? row : merge(current, row));
  };
  for (const item of sources) {
    if (item.kind === 'tool_call' && item.task !== null) {
      put(fromInfo(item.task, LIVE_TOOL_STATUSES.has(item.status)));
    } else if (item.kind === 'system' && item.event === 'task_notification') {
      put(fromInfo(item.task, true));
    }
  }
  const ambient = new Set<string>();
  for (const task of background) {
    if (task.ambient) {
      ambient.add(task.taskId);
      continue;
    }
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
  const all = [...rows.values()].filter((row) => !ambient.has(row.taskId));
  const running = all.filter((row) => row.running).sort((a, b) => startOf(a) - startOf(b));
  const finished = all.filter((row) => !row.running).sort((a, b) => endOf(b) - endOf(a));
  return [...running, ...finished];
}

/** Running rows and the rows that finished within `RECENT_TASK_MS` before `now`. */
export function visibleTaskRows(rows: readonly TaskRow[], now: number): TaskRow[] {
  return rows.filter((row) => row.running || endOf(row) >= now - RECENT_TASK_MS);
}

/** Runtime of a finished task in ms (usage, else end − start), null when unknown. */
export function finishedDuration(row: TaskRow): number | null {
  if (row.usage !== null) return row.usage.durationMs;
  const start = startOf(row);
  const end = endOf(row);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

// ---- todo list (TaskStrip, panel section) ----

export interface TodoProgress {
  done: number;
  total: number;
  /** `activeForm` (else `content`) of the first item in progress, null when none. */
  active: string | null;
  open: boolean;
}

export function todoProgress(todos: TodoList | null): TodoProgress {
  if (todos === null) return { done: 0, total: 0, active: null, open: false };
  const done = todos.items.filter((item) => item.status === 'completed').length;
  const current = todos.items.find((item) => item.status === 'in_progress');
  return {
    done,
    total: todos.items.length,
    active: current === undefined ? null : (nonEmpty(current.activeForm) ?? current.content),
    open: done < todos.items.length,
  };
}
