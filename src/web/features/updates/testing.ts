import { LOCAL_HOST_ID } from '@shared/common';
import type { AppInfo, HostState, SessionSummary, UpdateState } from '@shared/model';
import { sampleHostState, sampleId, sampleStatusFacts, sampleSummary } from '@shared/samples';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type HostConnection,
} from '@web/state/connection';
import { FakeHost, type FakeHostOptions } from '@web/state/fake-host';
import { createMemoryTransport } from '@web/state/transport';

/**
 * Fixtures of the updates feature (tests and playground; never imported by production code): an
 * installed Parallax 1.0.0 (the running version of `SAMPLE_UPDATE_STATES`), sessions a restart
 * would stop, and a FakeHost as host `local` (it answers `update.*` like the real service, WP-87).
 */

/** An installation (release.json + install root): updates in the app. */
export const PACKAGED_APP: AppInfo = { version: '1.0.0', buildId: '1.0.0+a1b2c3d', packaged: true };

/** A checkout (`pnpm dev`): "development build – updates via git". */
export const CHECKOUT_APP: AppInfo = { version: '1.0.0', buildId: '1.0.0+dev.4f5e6d7', packaged: false };

/** The host state of an installation with `update`. */
export function updateHostState(update: UpdateState, patch: Partial<HostState> = {}): HostState {
  return sampleHostState({ serverVersion: '1.0.0', app: PACKAGED_APP, update, ...patch });
}

/** One working, one waiting and one idle session (what "Restart now" lists). */
export function restartSessions(): SessionSummary[] {
  return [
    sampleSummary({
      entryId: sampleId('en', 881),
      title: 'Refactor the parser',
      status: sampleStatusFacts({ runState: 'working' }),
    }),
    sampleSummary({
      entryId: sampleId('en', 882),
      title: 'Approve the migration',
      status: sampleStatusFacts({
        runState: 'working',
        decisions: { permission: 1, question: 0, plan: 0, oldestKind: 'permission', expired: 0 },
      }),
    }),
    sampleSummary({
      entryId: sampleId('en', 883),
      title: 'Quiet session',
      status: sampleStatusFacts({ runState: 'idle' }),
    }),
  ];
}

export interface UpdatesHost {
  host: FakeHost;
  connection: HostConnection;
  stop: () => void;
}

/** A FakeHost with `hostState` as host `local` over a memory transport (the app's code path). */
export function startUpdatesHost(
  options: Pick<FakeHostOptions, 'hostState' | 'summaries' | 'onCommand'> = {},
): UpdatesHost {
  const transport = createMemoryTransport();
  const host = new FakeHost({ transport, ...options });
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    createTransport: () => transport,
    reload: () => undefined,
  });
  registerConnection(connection);
  connection.start();
  return {
    host,
    connection,
    stop: () => {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    },
  };
}
