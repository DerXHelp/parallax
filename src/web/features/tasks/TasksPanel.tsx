import { LayersIcon, SquareIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useT } from '@web/i18n';
import { useNow } from '@web/state/clock';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { TaskRowView } from './components/TaskRowView';
import { TodoItems } from './components/TodoItems';
import { canStopTask, todoProgress, visibleTaskRows, type TaskRow } from './lib/rows';
import { stopTask, stopTasks, useTaskRows, useTodos } from './state/tasks';

/**
 * Slot `TasksPanel` (WP-55, ADR-149/150): tab "Tasks" of the side panel. The session's task list
 * (detail.todos) on top, then its background tasks – running ones with Stop (the composer's Stop
 * ends only the turn, F4), finished ones greyed out for 10 minutes – and "Stop all" with an inline
 * confirmation (tasks are stopped one after the other).
 */

/** The clock of the 10-minute window: coarse, nothing visible depends on the second. */
const EXPIRY_TICK_MS = 15_000;

interface StopAllState {
  done: number;
  total: number;
}

export const TasksPanel = memo(function TasksPanel({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const rows = useTaskRows(sessionKey);
  const todos = useTodos(sessionKey);
  const now = useNow(EXPIRY_TICK_MS);
  const visible = useMemo(() => visibleTaskRows(rows, now), [rows, now]);
  const stoppable = useMemo(() => visible.filter((row) => canStopTask(row)), [visible]);
  const running = visible.filter((row) => row.running).length;
  const recent = visible.length - running;
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [stopAll, setStopAll] = useState<StopAllState | null>(null);

  const markStopping = useCallback((taskId: string, on: boolean) => {
    setStopping((current) => {
      const next = new Set(current);
      if (on) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }, []);

  const onStop = useCallback(
    (row: TaskRow) => {
      markStopping(row.taskId, true);
      stopTask(sessionKey, row.taskId).then(
        () => {
          // Success: the row turns finished with the next store update; failure: Stop again.
          markStopping(row.taskId, false);
        },
        () => {
          markStopping(row.taskId, false);
        },
      );
    },
    [sessionKey, markStopping],
  );

  const runStopAll = () => {
    const ids = stoppable.map((row) => row.taskId);
    setConfirming(false);
    setStopAll({ done: 0, total: ids.length });
    stopTasks(sessionKey, ids, (done) => {
      setStopAll({ done, total: ids.length });
    }).then(
      () => {
        setStopAll(null);
      },
      () => {
        setStopAll(null);
      },
    );
  };

  const progress = todoProgress(todos);
  return (
    <div
      data-slot="tasks-panel"
      role="region"
      aria-label={t('tasks.panel.label')}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex min-h-9 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground min-w-0 truncate">
          {[
            t('tasks.panel.running', { count: running }),
            recent === 0 ? null : t('tasks.panel.recent', { count: recent }),
          ]
            .filter((part) => part !== null)
            .join(' · ')}
        </span>
        <span className="flex-1" />
        {stopAll !== null ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5">
            <Spinner className="size-3" label={t('tasks.panel.stoppingAll', { ...stopAll })} />
            {t('tasks.panel.stoppingAll', { ...stopAll })}
          </span>
        ) : stoppable.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            data-slot="tasks-stop-all"
            disabled={confirming}
            onClick={() => {
              setConfirming(true);
            }}
          >
            <SquareIcon aria-hidden className="size-3" />
            {t('tasks.panel.stopAll')}
          </Button>
        ) : null}
      </div>
      {confirming && stopAll === null && stoppable.length > 0 ? (
        <div className="border-b p-3">
          <Alert
            tone="warning"
            data-slot="tasks-stop-all-confirm"
            title={t('tasks.panel.confirmTitle', { count: stoppable.length })}
            actions={
              <>
                <Button size="sm" variant="destructive" onClick={runStopAll}>
                  {t('tasks.panel.confirmStop')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  autoFocus
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  {t('tasks.panel.cancel')}
                </Button>
              </>
            }
          >
            {t('tasks.panel.confirmText')}
          </Alert>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 auto-rows-max gap-4 overflow-auto p-3">
        {todos === null || todos.items.length === 0 ? null : (
          <section aria-label={t('tasks.panel.todos')} data-slot="tasks-todos" className="grid gap-1.5">
            <h3 className="text-muted-foreground flex items-center gap-2 text-2xs font-medium uppercase">
              {t('tasks.panel.todos')}
              <span className="font-normal normal-case">
                {t('tasks.strip.progress', { done: progress.done, total: progress.total })}
              </span>
            </h3>
            <TodoItems items={todos.items} />
          </section>
        )}
        <section aria-label={t('tasks.panel.background')} className="grid gap-1.5">
          <h3 className="text-muted-foreground text-2xs font-medium uppercase">
            {t('tasks.panel.background')}
          </h3>
          {visible.length === 0 ? (
            <div
              data-slot="tasks-empty"
              className="text-muted-foreground flex items-start gap-2 py-2 text-xs"
            >
              <LayersIcon aria-hidden className="mt-px size-4 shrink-0" />
              <div className="grid gap-0.5">
                <p className="text-foreground font-medium">{t('tasks.panel.empty')}</p>
                <p>{t('tasks.panel.emptyHint')}</p>
              </div>
            </div>
          ) : (
            <ul className="grid gap-2">
              {visible.map((row) => (
                <TaskRowView
                  key={row.taskId}
                  sessionKey={sessionKey}
                  row={row}
                  stopping={stopping.has(row.taskId)}
                  disabled={stopAll !== null}
                  onStop={onStop}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
});

export default TasksPanel;
