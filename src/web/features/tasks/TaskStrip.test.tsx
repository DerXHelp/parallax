import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoList } from '@shared/model';
import { sampleTodoList } from '@shared/samples';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { registerShellRequestHandler, type ShellRequestOf } from '@web/shell/requests';
import { storageKey } from '@web/lib/storage';
import { clientStore, resetClientStore } from '@web/state/store';
import { TASKS_SLOTS } from './index';
import { TaskStrip } from './TaskStrip';
import { startTasksScenario, TASKS_ENTRY, TASKS_SESSION_KEY } from './testing';

let running: RunningScenario | null = null;
const STORAGE_KEY = storageKey('tasks', 'strip', TASKS_SESSION_KEY);

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const ALL_DONE: TodoList = sampleTodoList({
  items: sampleTodoList().items.map((item) => ({ ...item, status: 'completed' as const })),
});

function strip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="task-strip"]');
}

describe('TaskStrip', () => {
  it.each<[string, TodoList | null]>([
    ['no task list', null],
    ['every item done', ALL_DONE],
    ['an empty list', sampleTodoList({ items: [] })],
  ])('stays hidden with %s', async (_label, todos) => {
    running = startTasksScenario({ todos });
    const { container } = render(<TaskStrip sessionKey={TASKS_SESSION_KEY} />);
    // Once the snapshot is there.
    await waitFor(() => {
      expect(clientStore.getState().sessions[TASKS_SESSION_KEY]?.view ?? null).not.toBeNull();
    });
    expect(container.innerHTML).toBe('');
  });

  it('collapsed: one line with progress and the active item; expanded: the list – remembered per session', async () => {
    const user = userEvent.setup();
    running = startTasksScenario({ todos: sampleTodoList() });
    const { unmount } = render(<TaskStrip sessionKey={TASKS_SESSION_KEY} />);
    const toggle = await screen.findByRole('button', { name: '1 of 3 done · Writing the tests' });
    expect(strip()?.dataset.state).toBe('collapsed');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-slot="todo-items"]')).toBeNull();

    await user.click(toggle);
    expect(strip()?.dataset.state).toBe('expanded');
    const items = [...document.querySelectorAll<HTMLElement>('[data-slot="todo-items"] li')];
    expect(items.map((item) => [item.dataset.status, item.textContent])).toEqual([
      ['completed', 'CompletedRead the code'],
      ['in_progress', 'In progressWriting the tests'],
      ['pending', 'PendingRun the checks'],
    ]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('expanded');

    // A new mount (other window state, reload) starts expanded.
    unmount();
    render(<TaskStrip sessionKey={TASKS_SESSION_KEY} />);
    await waitFor(() => {
      expect(strip()?.dataset.state).toBe('expanded');
    });
    await user.click(screen.getByRole('button', { name: '1 of 3 done · Writing the tests' }));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('works without a usable localStorage (throws): collapsed, toggles in memory', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('denied');
    });
    running = startTasksScenario({ todos: sampleTodoList() });
    render(<TaskStrip sessionKey={TASKS_SESSION_KEY} />);
    const toggle = await screen.findByRole('button', { name: '1 of 3 done · Writing the tests' });
    expect(strip()?.dataset.state).toBe('collapsed');
    await user.click(toggle);
    expect(strip()?.dataset.state).toBe('expanded');
  });

  it('"Tasks" opens the panel tab via the shell request channel', async () => {
    const user = userEvent.setup();
    const requests: ShellRequestOf<'sidePanel'>[] = [];
    const unregister = registerShellRequestHandler('sidePanel', (request) => {
      requests.push(request);
      return true;
    });
    running = startTasksScenario({ todos: sampleTodoList() });
    render(<TaskStrip sessionKey={TASKS_SESSION_KEY} />);
    await user.click(await screen.findByRole('button', { name: 'Show the tasks in the side panel' }));
    unregister();
    expect(requests).toEqual([{ kind: 'sidePanel', sessionKey: TASKS_SESSION_KEY, tab: 'tasks' }]);
  });

  it('the slot loads the strip only while the session has open todos', async () => {
    running = startTasksScenario({ todos: ALL_DONE });
    const Slot = TASKS_SLOTS.TaskStrip;
    const { container } = render(<Slot sessionKey={TASKS_SESSION_KEY} />);
    await waitFor(() => {
      expect(clientStore.getState().sessions[TASKS_SESSION_KEY]?.view ?? null).not.toBeNull();
    });
    expect(container.innerHTML).toBe('');
    running.host.pushOps(TASKS_ENTRY, [{ op: 'detail.patch', patch: { todos: sampleTodoList() } }]);
    expect(
      await screen.findByRole('button', { name: '1 of 3 done · Writing the tests' }, { timeout: 10_000 }),
    ).toBeTruthy();
  });
});
