import { lazy, Suspense, useEffect, type CSSProperties, type ReactNode } from 'react';
import type { SessionDetailPatch } from '@shared/model';
import { samplePlanFileRef, sampleTodoList } from '@shared/samples';
import { NAVIGATION_ENTRIES, NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { startScenario } from '@web/playground/PlaygroundScenario';
import type { PlaygroundDemo } from '@web/playground/types';
import { useSummary } from '@web/state/hooks';
import { AppShell } from './AppShell';
import { SessionMenu } from './navigation/SessionMenu';
import { PaneLayout } from './PaneLayout';
import { SessionDropOverlay } from './session-drop';
import { SessionHeader } from './SessionHeader';
import { SessionPane } from './SessionPane';
import { SidebarFrame } from './SidebarFrame';
import { SlotBoundary } from './SlotBoundary';

/**
 * Playground demos of the WP-58 shell parts (no playground registry of its own – the preferences
 * playground lists them, see its README): header buttons with counters (wide and narrow), the
 * session menu with "Open folder in Explorer", the drop overlay, the sidebar in a 900 px and a
 * 700 px frame, and the SlotBoundary error cards. Data: the navigation scenario plus a detail patch
 * of the selected session (plan, background tasks, to-dos).
 */

const AUTH = NAVIGATION_SESSION_KEYS.auth;

type DetailVariant = 'busy' | 'todos' | 'plain';

const BACKGROUND_TASKS: SessionDetailPatch['backgroundTasks'] = [
  {
    taskId: 'task-watch',
    taskType: 'local_bash',
    description: 'pnpm test --watch',
    subagentType: null,
    parentTaskId: null,
    ambient: false,
  },
  {
    taskId: 'task-agent',
    taskType: 'local_agent',
    description: 'Review the auth middleware',
    subagentType: 'general-purpose',
    parentTaskId: null,
    ambient: false,
  },
];

function detailOf(variant: DetailVariant): SessionDetailPatch {
  switch (variant) {
    case 'busy':
      return {
        latestPlanVersion: 2,
        planFile: samplePlanFileRef(),
        backgroundTasks: BACKGROUND_TASKS,
        todos: sampleTodoList(),
      };
    case 'todos':
      return { latestPlanVersion: null, planFile: null, backgroundTasks: [], todos: sampleTodoList() };
    case 'plain':
      return { latestPlanVersion: null, planFile: null, backgroundTasks: [], todos: null };
  }
}

/** The navigation scenario with the auth session's detail patched while mounted. */
function Scenario({ variant, children }: { variant: DetailVariant; children: ReactNode }) {
  useEffect(() => {
    const running = startScenario('navigation');
    running.host.pushOps(NAVIGATION_ENTRIES.auth, [{ op: 'detail.patch', patch: detailOf(variant) }]);
    return () => {
      running.stop();
    };
  }, [variant]);
  return children;
}

/** A frame of a fixed width that also holds `position: fixed` children (the sidebar overlay). */
function Frame({ width, children }: { width: number; children: ReactNode }) {
  const style: CSSProperties = { width, transform: 'translateZ(0)' };
  return (
    <div style={style} className="bg-background flex h-[34rem] overflow-hidden rounded-md border">
      {children}
    </div>
  );
}

function HeaderAt({ width }: { width: number }) {
  return (
    <div style={{ width }} className="rounded-md border">
      <section data-session-key={AUTH}>
        <SessionHeader sessionKey={AUTH} />
      </section>
    </div>
  );
}

function OpenSessionMenu() {
  const summary = useSummary(AUTH);
  if (summary === null) return null;
  return (
    <div className="flex justify-end">
      <section data-session-key={AUTH}>
        <SessionMenu sessionKey={AUTH} summary={summary} defaultOpen />
      </section>
    </div>
  );
}

function Broken(): ReactNode {
  throw new Error('Demo render error');
}

const MissingChunk = lazy(() =>
  Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/demo-chunk.js')),
);

const noReload = () => undefined;

export const shellPhase3Demos: readonly PlaygroundDemo[] = [
  {
    id: 'shell-header-panels',
    title: 'Shell – Header: Plan, Files, Tasks (2 background tasks), wide and narrow',
    description: 'Upper header 900 px, lower 480 px: the buttons move into the “…” menu.',
    render: () => (
      <Scenario variant="busy">
        <div className="grid gap-4 p-6">
          <HeaderAt width={900} />
          <HeaderAt width={480} />
        </div>
      </Scenario>
    ),
  },
  {
    id: 'shell-header-todos',
    title: 'Shell – Header: open to-dos, no plan',
    render: () => (
      <Scenario variant="todos">
        <div className="grid gap-4 p-6">
          <HeaderAt width={900} />
        </div>
      </Scenario>
    ),
  },
  {
    id: 'shell-session-menu',
    title: 'Shell – Session menu with “Open folder in Explorer”',
    render: () => (
      <Scenario variant="plain">
        <div className="p-6 pr-24">
          <OpenSessionMenu />
        </div>
      </Scenario>
    ),
  },
  {
    id: 'shell-drop-overlay',
    title: 'Shell – Drop overlay over the session pane',
    description: 'Shown while files are dragged over transcript, header or side panel.',
    render: () => (
      <Scenario variant="busy">
        <div className="p-6">
          <Frame width={900}>
            <div className="relative min-w-0 flex-1">
              <SessionPane sessionKey={AUTH} />
              <SessionDropOverlay />
            </div>
          </Frame>
        </div>
      </Scenario>
    ),
  },
  {
    id: 'shell-window-900',
    title: 'Shell – Window 900 px: sidebar expanded (collapsible)',
    render: () => (
      <Scenario variant="busy">
        <div className="p-6">
          <Frame width={900}>
            <SidebarFrame narrow={false} />
            <main className="flex min-w-0 flex-1 flex-col">
              <PaneLayout />
            </main>
          </Frame>
        </div>
      </Scenario>
    ),
  },
  {
    id: 'shell-window-700',
    title: 'Shell – Window 700 px: sidebar as rail, “Show sessions” opens the overlay',
    render: () => (
      <Scenario variant="busy">
        <div className="p-6">
          <Frame width={700}>
            <SidebarFrame narrow />
            <main className="flex min-w-0 flex-1 flex-col">
              <PaneLayout />
            </main>
          </Frame>
        </div>
      </Scenario>
    ),
  },
  {
    id: 'shell-app-busy',
    title: 'Shell – Whole app with plan, background tasks and to-dos',
    description: 'Resize the window below 900 px to see the rail.',
    render: () => (
      <Scenario variant="busy">
        <AppShell />
      </Scenario>
    ),
  },
  {
    id: 'shell-slot-error',
    title: 'Shell – SlotBoundary: render error and missing chunk',
    description: '“Reload” retries the render error; the chunk card asks before reloading the window.',
    render: () => (
      <div className="grid max-w-xl gap-4 p-6">
        <SlotBoundary onReloadWindow={noReload}>
          <Broken />
        </SlotBoundary>
        <SlotBoundary onReloadWindow={noReload}>
          <Suspense fallback={null}>
            <MissingChunk />
          </Suspense>
        </SlotBoundary>
      </div>
    ),
  },
];
