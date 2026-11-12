/**
 * English texts of namespace `tasks` – task panel and task strip (Phase 3, WP-55; WP-50
 * registered the namespace as a stub).
 */
export const en = {
  title: 'Tasks',
  kind: {
    agent: 'Agent',
    bash: 'Shell',
    workflow: 'Workflow',
  },
  status: {
    started: 'Started',
    running: 'Running',
    pending: 'Waiting',
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
    killed: 'Killed',
  },
  panel: {
    label: 'Tasks of this session',
    todos: 'Task list',
    background: 'Background tasks',
    running: { one: '{count} running', other: '{count} running' },
    recent: { one: '{count} finished recently', other: '{count} finished recently' },
    /** `{running}` and `{recent}` are the two texts above. */
    summary: '{running} · {recent}',
    stopAll: 'Stop all',
    confirmTitle: { one: 'Stop the running task?', other: 'Stop all {count} running tasks?' },
    confirmText: 'The tasks are stopped one after the other; what they have done so far is kept.',
    confirmStop: 'Stop all',
    cancel: 'Cancel',
    stoppingAll: 'Stopping {done} of {total}…',
    empty: 'No background tasks',
    emptyHint:
      'Agents and shell commands running in the background appear here; finished ones stay for 10 minutes.',
  },
  row: {
    stop: 'Stop',
    stopLabel: 'Stop “{description}”',
    stopping: 'Stopping…',
    runtime: 'Runtime {duration}',
    tokens: '{count} tokens',
    toolUses: { one: '{count} tool use', other: '{count} tool uses' },
    output: 'Output file:',
    ended: '{status} at {time}',
  },
  strip: {
    label: 'Task list',
    progress: '{done} of {total} done',
    /** Collapsed strip: `{progress}` is the text above, `{active}` the item in progress. */
    line: '{progress} · {active}',
    openPanel: 'Tasks',
    openPanelLabel: 'Show the tasks in the side panel',
  },
  todo: {
    pending: 'Pending',
    in_progress: 'In progress',
    completed: 'Completed',
  },
};
