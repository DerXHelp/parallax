import type { TaskRow } from '@shared/tasks';

/**
 * Panel helpers of the task rows (WP-55, ADR-149/150), pure. The rows themselves – and the running
 * count the header shares – are `@shared/tasks` (CR3-02, WP-71: one model for panel, header and sidebar).
 */

/** Stop also for background shell commands (`local_bash`) – product switch, on by default. */
export const TASK_STOP_BASH = true;
/** Finished tasks stay visible (greyed out) this long. */
export const RECENT_TASK_MS = 10 * 60_000;

/** Can the user stop this row (running; shell commands only while `TASK_STOP_BASH`)? */
export function canStopTask(row: TaskRow, stopBash: boolean = TASK_STOP_BASH): boolean {
  return row.running && (row.kind !== 'bash' || stopBash);
}

function startOf(row: TaskRow): number {
  const ms = row.startedAt === null ? Number.NaN : Date.parse(row.startedAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function endOf(row: TaskRow): number {
  const ms = row.endedAt === null ? Number.NaN : Date.parse(row.endedAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
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
