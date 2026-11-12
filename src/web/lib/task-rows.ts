import type { BackgroundTask, TaskInfo, TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';

/**
 * The task model of a session (WP-55, ADR-149/150), pure: the background tasks of `detail` plus the
 * tasks of tool calls (Agent, background Bash) and of `task_notification` items, one row per
 * `taskId`. A task counts as finished as soon as any source says so (status outside the open set,
 * `endedAt`, or its tool call no longer running) – stale "running" data never resurrects it.
 *
 * One model for the task panel and the counter of the header's "Tasks" button (CR3-02, ADR-158):
 * both count `runningTaskCount(buildTaskRows(…))`. Here, not in the feature, because the shell
 * imports no feature (ADR-126). Left out like on the server: ambient background tasks. Left out as
 * part of their agent: a subagent's foreground shell (`local_bash`, `isBackgrounded: false`,
 * WP61-06). Running – and so stoppable – only what the server's `session.stopTask` accepts: a
 * listed background task or a tool call `running`/`background` (CR3-07; `pending` has not started).
 */

const OPEN_STATUSES: ReadonlySet<string> = new Set(['started', 'running', 'pending']);
/** Tool call states whose task runs (= `hasStoppableTask` of the server). */
const LIVE_TOOL_STATUSES: ReadonlySet<string> = new Set(['running', 'background']);

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

const sourceCache = new WeakMap<readonly TranscriptItem[], TranscriptItem[]>();

/**
 * `taskSourceItems(view.items)`, cached per items array: cheap in selectors that run on every store
 * change. The same task items give equal (shallow) arrays, so text deltas re-render nothing.
 */
export function selectTaskSources(view: SessionViewState): readonly TranscriptItem[] {
  const cached = sourceCache.get(view.items);
  if (cached !== undefined) return cached;
  const sources = taskSourceItems(view.items);
  sourceCache.set(view.items, sources);
  return sources;
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
      put(fromInfo(item.task, LIVE_TOOL_STATUSES.has(item.status)));
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
