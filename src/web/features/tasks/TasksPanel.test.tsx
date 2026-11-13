import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { sampleTodoList } from '@shared/samples';
import type { TaskRow } from '@shared/tasks';
import type { RunningScenario } from '@web/playground/PlaygroundScenario';
import { FeatureSlotsProvider, type FeatureSlots, type FileLinkSlotProps } from '@web/shell/slots';
import { refreshClock } from '@web/state/clock';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import type * as RowsModule from './lib/rows';
import { TasksPanel } from './TasksPanel';
import { mixedTaskSession, startTasksScenario, TASKS_SESSION_KEY } from './testing';

/** The product switch `TASK_STOP_BASH` as the panel sees it (through `canStopTask`). */
const flags = vi.hoisted(() => ({ stopBash: true }));
vi.mock('./lib/rows', async (importOriginal) => {
  const actual = await importOriginal<typeof RowsModule>();
  return {
    ...actual,
    canStopTask: (row: TaskRow, stopBash: boolean = flags.stopBash) => actual.canStopTask(row, stopBash),
  };
});

/** FileLink stand-in: shows the props it got. */
function ProbeFileLink({ path, verify, children }: FileLinkSlotProps) {
  return (
    <span data-testid="file-link" data-path={path} data-verify={String(verify)}>
      {children ?? path}
    </span>
  );
}
const SLOTS: Partial<FeatureSlots> = { FileLink: ProbeFileLink };

let running: RunningScenario | null = null;

// Several clicks per test against the FakeHost: well under a second alone, more under parallel
// load (docs/wp/FLAKES.md – limits per file).
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  running?.stop();
  running = null;
  resetClientStore();
  vi.useRealTimers();
  refreshClock();
  flags.stopBash = true;
});

function renderPanel() {
  return render(
    <TooltipProvider>
      <FeatureSlotsProvider slots={SLOTS}>
        <TasksPanel sessionKey={TASKS_SESSION_KEY} />
      </FeatureSlotsProvider>
    </TooltipProvider>,
  );
}

function rows() {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="task-row"]')].map(
    (row) => `${row.dataset.taskId ?? ''}:${row.dataset.state ?? ''}`,
  );
}

function row(taskId: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="task-row"][data-task-id="${taskId}"]`);
  if (element === null) throw new Error(`no row ${taskId}`);
  return element;
}

function stopCommands(scenario: RunningScenario): string[] {
  return scenario.host.commands.flatMap((cmd) => (cmd.name === 'session.stopTask' ? [cmd.taskId] : []));
}

describe('TasksPanel', () => {
  it('shows an empty state without tasks', async () => {
    running = startTasksScenario({});
    renderPanel();
    expect(await screen.findByText('No background tasks')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull();
  });

  it('merges background tasks and task tool calls; finished ones stay 10 minutes, ambient ones never show', async () => {
    running = startTasksScenario(mixedTaskSession(Date.now()));
    renderPanel();
    await waitFor(() => {
      expect(rows()).toEqual([
        'task_agent:running',
        'task_bash:running',
        'task_deploy:running',
        'task_failed:finished',
        'task_done:finished',
      ]);
    });
    expect(screen.getByText('3 running · 2 finished recently')).toBeTruthy();
    const agent = within(row('task_agent'));
    expect(agent.getByText('Agent')).toBeTruthy();
    expect(agent.getByText('Explore')).toBeTruthy();
    expect(agent.getByText('Read 4 of 7 test files; one flaky timeout in hub.test.ts')).toBeTruthy();
    expect(agent.getByText('18.2K tokens')).toBeTruthy();
    expect(agent.getByText('9 tool uses')).toBeTruthy();
    expect(agent.getByText(/^Runtime 3 min/)).toBeTruthy();
    expect(agent.getByTestId('file-link').dataset).toMatchObject({
      path: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_agent.output',
      verify: 'false',
    });
    expect(within(row('task_bash')).getByText('Shell')).toBeTruthy();
    expect(within(row('task_deploy')).getByText('Workflow')).toBeTruthy();
    // Finished: greyed out, status instead of Stop.
    expect(row('task_failed').className).toContain('opacity-60');
    expect(within(row('task_failed')).getByText(/^Failed at /)).toBeTruthy();
    expect(within(row('task_failed')).queryByRole('button')).toBeNull();
    // Every running task can be stopped – Bash too (TASK_STOP_BASH).
    for (const id of ['task_agent', 'task_bash', 'task_deploy']) {
      expect(within(row(id)).getByRole('button', { name: /^Stop “/ })).toBeTruthy();
    }
  });

  it('a finished task disappears 10 minutes after its end (clock)', async () => {
    const now = Date.now();
    running = startTasksScenario(mixedTaskSession(now));
    renderPanel();
    await waitFor(() => {
      expect(rows()).toContain('task_done:finished');
    });
    // task_done ended 2 minutes ago, task_failed 1 minute ago.
    vi.setSystemTime(now + 8.5 * 60_000);
    refreshClock();
    await waitFor(() => {
      expect(rows()).not.toContain('task_done:finished');
    });
    expect(rows()).toContain('task_failed:finished');
  });

  it('Stop stops one task (session.stopTask); the row turns finished', async () => {
    const user = userEvent.setup();
    const scenario = startTasksScenario(mixedTaskSession(Date.now()));
    running = scenario;
    renderPanel();
    const stop = await within(await waitFor(() => row('task_agent'))).findByRole('button', {
      name: 'Stop “Review the sync tests”',
    });
    await user.click(stop);
    await waitFor(() => {
      expect(rows()).toContain('task_agent:finished');
    });
    expect(stopCommands(scenario)).toEqual(['task_agent']);
    expect(within(row('task_agent')).getByText(/^Stopped at /)).toBeTruthy();
    expect(clientStore.getState().notices).toEqual([]);
  });

  it('"Stop all" asks first, then stops the running tasks one after the other', async () => {
    const user = userEvent.setup();
    const scenario = startTasksScenario(mixedTaskSession(Date.now()));
    running = scenario;
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Stop all' }));
    const confirm = document.querySelector('[data-slot="tasks-stop-all-confirm"]');
    expect(confirm?.textContent).toContain('Stop all 3 running tasks?');
    // Cancel has the focus (no accidental stop with Enter).
    expect(document.activeElement?.textContent).toBe('Cancel');
    await user.keyboard('{Enter}');
    expect(document.querySelector('[data-slot="tasks-stop-all-confirm"]')).toBeNull();
    expect(stopCommands(scenario)).toEqual([]);
    // R5W-07: the focus goes back to "Stop all" (not to the body).
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop all' }));

    await user.click(screen.getByRole('button', { name: 'Stop all' }));
    const confirmBox = document.querySelector<HTMLElement>('[data-slot="tasks-stop-all-confirm"]');
    if (confirmBox === null) throw new Error('no confirmation');
    await user.click(within(confirmBox).getByRole('button', { name: 'Stop all' }));
    await waitFor(() => {
      expect(rows().filter((entry) => entry.endsWith(':running'))).toEqual([]);
    });
    // In list order (one after the other: state/tasks.test.ts).
    expect(stopCommands(scenario)).toEqual(['task_agent', 'task_bash', 'task_deploy']);
    expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull();
    // "Stop all" is gone: the focus stays in the panel (R5W-07).
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Tasks of this session' }));
  });

  it('with TASK_STOP_BASH off, a running shell command has no Stop and "Stop all" skips it (R5W-11)', async () => {
    flags.stopBash = false;
    const user = userEvent.setup();
    const scenario = startTasksScenario(mixedTaskSession(Date.now()));
    running = scenario;
    renderPanel();
    await waitFor(() => {
      expect(rows()).toContain('task_bash:running');
    });
    expect(within(row('task_bash')).queryByRole('button')).toBeNull();
    expect(
      within(row('task_agent')).getByRole('button', { name: 'Stop “Review the sync tests”' }),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stop all' }));
    const confirmBox = document.querySelector<HTMLElement>('[data-slot="tasks-stop-all-confirm"]');
    expect(confirmBox?.textContent).toContain('Stop all 2 running tasks?');
    if (confirmBox === null) throw new Error('no confirmation');
    await user.click(within(confirmBox).getByRole('button', { name: 'Stop all' }));
    await waitFor(() => {
      expect(stopCommands(scenario)).toEqual(['task_agent', 'task_deploy']);
    });
    await waitFor(() => {
      expect(rows()).toContain('task_deploy:finished');
    });
    expect(rows()).toContain('task_bash:running');
  });

  it('a failed stop shows a notice and keeps the row; TASK_NOT_FOUND stays silent', async () => {
    const user = userEvent.setup();
    const scenario = startTasksScenario(mixedTaskSession(Date.now()));
    running = scenario;
    scenario.host.failNext('session.stopTask', makeError('TASK_NOT_FOUND', { taskId: 'task_bash' }));
    scenario.host.failNext('session.stopTask', makeError('INTERNAL_ERROR'));
    renderPanel();
    const stop = await within(await waitFor(() => row('task_bash'))).findByRole('button', {
      name: 'Stop “pnpm test --watch”',
    });
    await user.click(stop);
    await waitFor(() => {
      expect(stop).toHaveProperty('disabled', false);
    });
    expect(clientStore.getState().notices).toEqual([]);
    await user.click(stop);
    await waitFor(() => {
      expect(
        clientStore
          .getState()
          .notices.map((notice) => ('error' in notice.content ? notice.content.error.code : null)),
      ).toEqual(['INTERNAL_ERROR']);
    });
    expect(rows()).toContain('task_bash:running');
    expect(stopCommands(scenario)).toEqual(['task_bash', 'task_bash']);
  });

  it('shows the task list of the session above the tasks', async () => {
    running = startTasksScenario({ todos: sampleTodoList() });
    renderPanel();
    const section = await screen.findByRole('region', { name: 'Task list' });
    expect(within(section).getByText('1 of 3 done')).toBeTruthy();
    expect(within(section).getByText('Writing the tests')).toBeTruthy();
    expect(screen.getByText('No background tasks')).toBeTruthy();
  });
});
