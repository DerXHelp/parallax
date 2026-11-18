import { makeSessionKey } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import {
  sampleHostState,
  sampleId,
  sampleRemoteHost,
  sampleStatusFacts,
  sampleSummary,
} from '@shared/samples';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { startFakeComputers, type FakeComputers, type FakeComputerSpec } from '@web/state/fake-computers';
import type { RemoteConnectionOptions } from '@web/state/remote-hosts';
import type { ClientStore } from '@web/state/store';

/**
 * Two other computers for the tests and the playground demos of WP-80 (neutral names): "Computer
 * B" with two sessions (one waits for the user, one in the same folder as a local session) and
 * "Computer C" with one. Added to the scenario `navigation` (this computer).
 */

export const DEMO_HOSTS = { b: 'computer-b', c: 'computer-c' } as const;

export const DEMO_REMOTE_ENTRIES = {
  pipeline: sampleId('en', 201),
  landing: sampleId('en', 202),
  lab: sampleId('en', 211),
} as const;

export const DEMO_HOST_KEYS = {
  pipeline: makeSessionKey(DEMO_HOSTS.b, DEMO_REMOTE_ENTRIES.pipeline),
  landing: makeSessionKey(DEMO_HOSTS.b, DEMO_REMOTE_ENTRIES.landing),
  lab: makeSessionKey(DEMO_HOSTS.c, DEMO_REMOTE_ENTRIES.lab),
} as const;

/** Folder of the remote session that has the same path as a local project (two groups by folder). */
export const DEMO_SHARED_FOLDER = 'D:\\work\\web\\landing';

function minutesAgo(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

function summary(
  now: number,
  p: Partial<SessionSummary> & { minutes: number; waiting?: boolean },
): SessionSummary {
  const { minutes, waiting = false, ...rest } = p;
  return sampleSummary({
    lastActivityAt: minutesAgo(now, minutes),
    status: sampleStatusFacts(
      waiting
        ? {
            runState: 'working',
            decisions: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
          }
        : { runState: 'idle' },
    ),
    ...rest,
  });
}

/** The two computers (their list entries and their sessions). */
export function demoComputerSpecs(now: number = Date.now()): FakeComputerSpec[] {
  return [
    {
      remote: sampleRemoteHost({ hostId: DEMO_HOSTS.b, name: 'Computer B', color: 'teal' }),
      hostState: sampleHostState({ dataDirLabel: 'computer-b' }),
      summaries: [
        summary(now, {
          entryId: DEMO_REMOTE_ENTRIES.pipeline,
          title: 'Build pipeline',
          cwd: 'C:\\build\\pipeline',
          minutes: 3,
          waiting: true,
        }),
        summary(now, {
          entryId: DEMO_REMOTE_ENTRIES.landing,
          title: 'Landing page on B',
          cwd: DEMO_SHARED_FOLDER,
          minutes: 40,
          hasDraft: true,
        }),
      ],
    },
    {
      remote: sampleRemoteHost({
        hostId: DEMO_HOSTS.c,
        name: 'Computer C',
        color: 'violet',
        address: '192.0.2.30',
      }),
      hostState: sampleHostState({ dataDirLabel: 'computer-c' }),
      summaries: [
        summary(now, {
          entryId: DEMO_REMOTE_ENTRIES.lab,
          title: 'Lab notes',
          cwd: 'E:\\lab\\notes',
          minutes: 90,
        }),
      ],
    },
  ];
}

export interface RunningHostsDemo {
  scenario: RunningScenario;
  computers: FakeComputers;
  stop(): void;
}

/** Scenario `navigation` on this computer plus the two other computers (role "control"). */
export function startHostsDemo(
  options: { select?: string | null; store?: ClientStore; connectionOptions?: RemoteConnectionOptions } = {},
): RunningHostsDemo {
  const scenario = startScenario('navigation', {
    ...(options.select === undefined ? {} : { select: options.select }),
    ...(options.store === undefined ? {} : { store: options.store }),
  });
  scenario.host.multiHost = {};
  const computers = startFakeComputers(scenario.host, demoComputerSpecs(), {
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.connectionOptions === undefined ? {} : { connectionOptions: options.connectionOptions }),
  });
  return {
    scenario,
    computers,
    stop() {
      computers.stop();
      scenario.stop();
    },
  };
}
