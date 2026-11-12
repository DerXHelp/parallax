import { useEffect, useState, type ReactNode } from 'react';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { sampleId, sampleTodoList } from '@shared/samples';
import type { PlaygroundDemo } from '@web/playground/types';
import type { FeatureSlots } from '@web/shell/slots';
import { writeStripExpanded } from './state/strip';
import { TaskStrip } from './TaskStrip';
import { TasksPanel } from './TasksPanel';
import {
  ago,
  backgroundTask,
  mixedTaskSession,
  startTasksScenario,
  taskInfo,
  taskTool,
  TASKS_SESSION_KEY,
  type TasksSessionSetup,
} from './testing';

/**
 * Playground demos of the tasks feature (`#playground=tasks/<id>`): the panel empty, with every
 * kind of task (Stop and "Stop all" work against the FakeHost) and with a single shell command;
 * the task strip collapsed and expanded. `slots` puts the real (non-lazy) panel and strip into the
 * shell demos; App.tsx wires the lazy ones from index.ts (WP-60).
 */

const EXPANDED_ENTRY = sampleId('en', 552);
const EXPANDED_KEY = makeSessionKey(LOCAL_HOST_ID, EXPANDED_ENTRY);

/** Runs the sessions while mounted (like the transcript demos: the views subscribe on connect). */
function TasksDemo({ sessions, children }: { sessions: () => TasksSessionSetup[]; children: ReactNode }) {
  useEffect(() => {
    const running = startTasksScenario(...sessions());
    return () => {
      running.stop();
    };
  }, [sessions]);
  return children;
}

function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="p-4">
      <div className="bg-background flex h-[600px] w-[440px] max-w-full flex-col overflow-hidden rounded-md border">
        {children}
      </div>
    </div>
  );
}

const emptySession = (): TasksSessionSetup[] => [{}];
const mixedSessions = (): TasksSessionSetup[] => [
  { ...mixedTaskSession(Date.now()), todos: sampleTodoList() },
];
const bashSessions = (): TasksSessionSetup[] => {
  const now = Date.now();
  const bash = taskInfo('task_dev_server', {
    taskType: 'local_bash',
    description: 'pnpm dev --port 5185',
    startedAt: ago(now, 14 * 60_000),
    outputFile: 'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\tasks\\task_dev_server.output',
  });
  return [
    {
      items: [taskTool(1, bash)],
      backgroundTasks: [
        backgroundTask('task_dev_server', { taskType: 'local_bash', description: bash.description }),
      ],
    },
  ];
};
const stripSessions = (): TasksSessionSetup[] => [
  { todos: sampleTodoList() },
  { entryId: EXPANDED_ENTRY, todos: sampleTodoList() },
];

/** The strips read their state when they mount: written before (idempotent, so twice is fine). */
function StripDemo() {
  useState(() => {
    writeStripExpanded(TASKS_SESSION_KEY, false);
    writeStripExpanded(EXPANDED_KEY, true);
    return null;
  });
  return (
    <TasksDemo sessions={stripSessions}>
      <div className="grid max-w-3xl gap-6 p-4">
        <div className="bg-background rounded-md border">
          <TaskStrip sessionKey={TASKS_SESSION_KEY} />
        </div>
        <div className="bg-background rounded-md border">
          <TaskStrip sessionKey={EXPANDED_KEY} />
        </div>
      </div>
    </TasksDemo>
  );
}

function panelDemo(
  id: string,
  title: string,
  description: string,
  sessions: () => TasksSessionSetup[],
): PlaygroundDemo {
  return {
    id,
    title,
    description,
    render: () => (
      <TasksDemo sessions={sessions}>
        <PanelFrame>
          <TasksPanel sessionKey={TASKS_SESSION_KEY} />
        </PanelFrame>
      </TasksDemo>
    ),
  };
}

export const demos: PlaygroundDemo[] = [
  panelDemo('panel-empty', 'Task panel: empty', 'No background tasks, no task list', emptySession),
  panelDemo(
    'panel',
    'Task panel: several tasks',
    'Task list on top; agent, shell and workflow running (Stop, "Stop all" with confirmation), finished ones greyed out, an expired and an ambient task hidden',
    mixedSessions,
  ),
  panelDemo(
    'panel-bash',
    'Task panel: shell command',
    'One background Bash task (TASK_STOP_BASH on)',
    bashSessions,
  ),
  {
    id: 'strip',
    title: 'Task strip: collapsed and expanded',
    description:
      'Above the composer while the task list has open items; the state is kept per session (localStorage)',
    render: () => <StripDemo />,
  },
];

export const slots: Partial<FeatureSlots> = { TasksPanel, TaskStrip };
