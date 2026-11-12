import type { TodoList } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import { useSessionSelector } from '@web/state/hooks';

/**
 * The session's task list (`detail.todos`, WP-55, ADR-150) – its own module (R5W-01), so the strip
 * chunk does not pull in the panel rows (`lib/rows.ts` via `state/tasks.ts`).
 */

const selectTodos = (view: SessionViewState): TodoList | null => view.detail.todos;

export function useTodos(sessionKey: string): TodoList | null {
  return useSessionSelector(sessionKey, selectTodos, null);
}
