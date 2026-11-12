import { ListChecksIcon, PanelRightIcon } from 'lucide-react';
import { memo } from 'react';
import { useT } from '@web/i18n';
import { requestShell } from '@web/shell/requests';
import { Button } from '@web/ui/button';
import { Disclosure } from '@web/ui/disclosure';
import { TodoItems } from './components/TodoItems';
import { todoProgress } from './lib/rows';
import { useStripExpanded } from './state/strip';
import { useTodos } from './state/tasks';

/**
 * Slot `TaskStrip` (WP-55, ADR-150): the pinned task list above the composer, only while
 * `detail.todos` has open items. Collapsed one line "n of m done · <activeForm>", expanded the list
 * with status icons (state per session in localStorage). "Tasks" opens the panel tab.
 */
export const TaskStrip = memo(function TaskStrip({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const todos = useTodos(sessionKey);
  const [expanded, setExpanded] = useStripExpanded(sessionKey);
  const progress = todoProgress(todos);
  if (todos === null || !progress.open) return null;
  const line = [t('tasks.strip.progress', { done: progress.done, total: progress.total }), progress.active]
    .filter((part) => part !== null && part !== '')
    .join(' · ');
  return (
    <section
      data-slot="task-strip"
      data-state={expanded ? 'expanded' : 'collapsed'}
      aria-label={t('tasks.strip.label')}
      className="border-t px-3 py-1"
    >
      <Disclosure
        open={expanded}
        onOpenChange={setExpanded}
        header={
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <ListChecksIcon aria-hidden className="text-info size-3.5 shrink-0" />
            <span data-slot="task-strip-line" className="min-w-0 truncate">
              {line}
            </span>
          </span>
        }
        actions={
          <Button
            size="sm"
            variant="ghost"
            data-slot="task-strip-open"
            aria-label={t('tasks.strip.openPanelLabel')}
            onClick={() => {
              requestShell({ kind: 'sidePanel', sessionKey, tab: 'tasks' });
            }}
          >
            <PanelRightIcon aria-hidden className="size-3.5" />
            {t('tasks.strip.openPanel')}
          </Button>
        }
      >
        <TodoItems items={todos.items} className="max-h-40 overflow-auto py-1 pl-6" />
      </Disclosure>
    </section>
  );
});

export default TaskStrip;
