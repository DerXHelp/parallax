import type { TodoItem, TodoList } from '@shared/model';

/**
 * Progress of the session's task list (WP-55, ADR-150), pure. Its own small module (R5W-01): the
 * strip slot in `index.ts` checks for open todos in the start chunk, while the rows of the panel
 * (`rows.ts`) stay in the lazy panel chunk.
 */

export interface TodoProgress {
  done: number;
  total: number;
  /** `activeForm` (else `content`) of the first item in progress, null when none. */
  active: string | null;
  open: boolean;
}

function activeText(item: TodoItem): string {
  return item.activeForm === null || item.activeForm === '' ? item.content : item.activeForm;
}

export function todoProgress(todos: TodoList | null): TodoProgress {
  if (todos === null) return { done: 0, total: 0, active: null, open: false };
  const done = todos.items.filter((item) => item.status === 'completed').length;
  const current = todos.items.find((item) => item.status === 'in_progress');
  return {
    done,
    total: todos.items.length,
    active: current === undefined ? null : activeText(current),
    open: done < todos.items.length,
  };
}
