import type { RunningTasks, TaskKind } from '@shared/model';
import { useT } from '@web/i18n';
import { TASK_KIND_ICON } from '../running-tasks';

const KIND_KEY: Readonly<Record<TaskKind, 'agent' | 'bash' | 'workflow' | 'task'>> = {
  agent: 'agent',
  bash: 'bash',
  workflow: 'workflow',
  other: 'task',
};

/**
 * WP-71: "Running now" in the sidebar row's tooltip – up to five tasks (kind, agent type, label),
 * then "and `more` more". Its own chunk (start bundle, §1.5): `SessionRow` loads it once tasks run.
 */
export function RowTasksDetail({ tasks, more }: { tasks: RunningTasks; more: number }) {
  const t = useT();
  return (
    <span data-slot="row-tasks-detail" className="mt-0.5 grid gap-0.5">
      <span className="font-medium">{t('navigation.running.title')}</span>
      {tasks.items.map((item, index) => {
        const Icon = TASK_KIND_ICON[item.kind];
        return (
          <span
            key={`${item.kind}:${String(index)}`}
            data-slot="row-task"
            data-kind={item.kind}
            className="flex min-w-0 items-start gap-1.5"
          >
            <Icon aria-hidden className="text-status-working mt-0.5 size-3 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="text-muted-foreground">
                {t(`navigation.running.kind.${KIND_KEY[item.kind]}`)}
                {item.subagentType === null ? null : (
                  <>
                    <span aria-hidden className="mx-1">
                      ·
                    </span>
                    {item.subagentType}
                  </>
                )}
                {item.label === '' ? null : ':'}
              </span>
              {item.label === '' ? null : <span className="ml-1">{item.label}</span>}
            </span>
          </span>
        );
      })}
      {more > 0 ? (
        <span className="text-muted-foreground">{t('navigation.running.more', { count: more })}</span>
      ) : null}
    </span>
  );
}
