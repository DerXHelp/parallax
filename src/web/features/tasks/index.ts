import { createElement, lazy, memo, Suspense } from 'react';
import type { SessionViewState } from '@shared/sync';
import type { FeatureSlots } from '@web/shell/slots';
import { useSessionSelector } from '@web/state/hooks';
import { todoProgress } from './lib/rows';

/**
 * Feature `tasks` (WP-55): the slots `TasksPanel` (side panel tab "Tasks") and `TaskStrip` (above
 * the composer). Both are lazy chunks; the strip slot first checks for open todos with a cheap
 * selector, so a session without a task list loads nothing. WP-60 wires them in App.tsx
 * (`...TASKS_SLOTS`); tests and the playground import the modules directly.
 */

const LazyTasksPanel = lazy(() => import('./TasksPanel'));
const LazyTaskStrip = lazy(() => import('./TaskStrip'));

const selectHasOpenTodos = (view: SessionViewState): boolean => todoProgress(view.detail.todos).open;

const TasksPanelSlot = memo(function TasksPanelSlot(props: { sessionKey: string }) {
  return createElement(Suspense, { fallback: null }, createElement(LazyTasksPanel, props));
});

const TaskStripSlot = memo(function TaskStripSlot(props: { sessionKey: string }) {
  const open = useSessionSelector(props.sessionKey, selectHasOpenTodos, false);
  if (!open) return null;
  return createElement(Suspense, { fallback: null }, createElement(LazyTaskStrip, props));
});

export const TASKS_SLOTS: Pick<FeatureSlots, 'TasksPanel' | 'TaskStrip'> = {
  TasksPanel: TasksPanelSlot,
  TaskStrip: TaskStripSlot,
};
