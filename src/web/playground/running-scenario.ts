import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import type { BackgroundTask, RunningTasks, Settings } from '@shared/model';
import { NAVIGATION_ENTRIES, navigationData, type NavigationData } from './navigation-scenario';

/**
 * Playground data for WP-71 ("what runs where"): the navigation sessions with one working session
 * (two background agents and a dev server, the live line on a Bash call), one session where only a
 * shell keeps running (status "background") and the rest resting. The working session's background
 * list feeds the header's task counter.
 */

export const RUNNING_DEMO_ENTRIES = {
  working: NAVIGATION_ENTRIES.redirect,
  background: NAVIGATION_ENTRIES.auth,
} as const;

export const RUNNING_DEMO_SESSION_KEYS = {
  working: makeSessionKey(LOCAL_HOST_ID, RUNNING_DEMO_ENTRIES.working),
  background: makeSessionKey(LOCAL_HOST_ID, RUNNING_DEMO_ENTRIES.background),
} as const;

export const RUNNING_DEMO_TASKS: { working: RunningTasks; background: RunningTasks } = {
  working: {
    agents: 2,
    shells: 1,
    other: 0,
    items: [
      { kind: 'agent', subagentType: 'general-purpose', label: 'Reading the API handlers' },
      { kind: 'agent', subagentType: 'general-purpose', label: 'Collecting the schema changes' },
      { kind: 'bash', subagentType: null, label: 'Start the dev server' },
    ],
  },
  background: {
    agents: 0,
    shells: 1,
    other: 0,
    items: [{ kind: 'bash', subagentType: null, label: 'Watch the tests' }],
  },
};

const WORKING_BACKGROUND: BackgroundTask[] = [
  {
    taskId: 'wp71-agent-1',
    taskType: 'local_agent',
    description: 'Review the API module',
    subagentType: 'general-purpose',
    parentTaskId: null,
    ambient: false,
  },
  {
    taskId: 'wp71-agent-2',
    taskType: 'local_agent',
    description: 'Write the migration notes',
    subagentType: 'general-purpose',
    parentTaskId: null,
    ambient: false,
  },
  {
    taskId: 'wp71-shell-1',
    taskType: 'local_bash',
    description: 'Start the dev server',
    subagentType: null,
    parentTaskId: null,
    ambient: false,
  },
];

export function runningData(now: number, settings: Settings): NavigationData {
  const data = navigationData(now, settings);
  const summaries = data.summaries.map((summary) => {
    if (summary.entryId === RUNNING_DEMO_ENTRIES.working) {
      return {
        ...summary,
        activity: { kind: 'tool' as const, tool: 'Bash', target: 'pnpm test --filter api' },
        runningTasks: RUNNING_DEMO_TASKS.working,
        status: { ...summary.status, runState: 'working' as const, backgroundTasks: 3 },
      };
    }
    if (summary.entryId === RUNNING_DEMO_ENTRIES.background) {
      return {
        ...summary,
        runningTasks: RUNNING_DEMO_TASKS.background,
        status: { ...summary.status, runState: 'idle' as const, unread: false, backgroundTasks: 1 },
      };
    }
    return summary;
  });
  const sessions = data.sessions.map((snapshot) =>
    snapshot.entryId === RUNNING_DEMO_ENTRIES.working
      ? { ...snapshot, detail: { ...snapshot.detail, backgroundTasks: WORKING_BACKGROUND } }
      : snapshot,
  );
  return { ...data, summaries, sessions };
}
