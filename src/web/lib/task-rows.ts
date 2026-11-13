import type { TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { taskSourceItems } from '@shared/tasks';

/**
 * The web side of the task model (WP-55, ADR-158): since WP-71 the pure model – `buildTaskRows`,
 * `runningTaskCount`, `runningTaskCounts`, `isToolCallTaskLive` … – lives in `@shared/tasks`, so the
 * server's `SessionSummary.runningTasks` (sidebar) counts exactly like the task panel and the
 * header. Here only the store selector; the rest is re-exported for the existing importers.
 */
export {
  buildTaskRows,
  countRunningTasks,
  isLiveToolStatus,
  isToolCallTaskLive,
  runningTaskCount,
  runningTaskCounts,
  taskKind,
  taskSourceItems,
  type RunningTaskCounts,
  type TaskKind,
  type TaskRow,
} from '@shared/tasks';

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
