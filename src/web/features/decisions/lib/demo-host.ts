import { LOCAL_HOST_ID, makeSessionKey, type EntryId } from '@shared/common';
import type { HostState, SessionSummary } from '@shared/model';
import type { Command, SessionSnapshot } from '@shared/protocol';
import { sampleHostState } from '@shared/samples';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type ManagedHostConnection,
} from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { setSelectedSession } from '@web/state/selection';
import { createMemoryTransport } from '@web/state/transport';

/**
 * A FakeHost behind a real HostConnection on host `local` (same code path as the app) for the
 * playground demos and the component tests of WP-16 – with own sessions and command handling
 * (`startScenario` of WP-14 only knows its fixed scenarios). Dev/test only: nothing in the app
 * imports this module.
 */

export interface DemoHostOptions {
  summaries: readonly SessionSummary[];
  sessions: readonly SessionSnapshot[];
  hostState?: HostState;
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  replyToPrompts?: boolean;
  /** Session selected in the window (default: none). */
  select?: string | null;
  /** Ops are applied right away instead of once per animation frame (tests). */
  immediate?: boolean;
}

export interface DemoHost {
  host: FakeHost;
  connection: ManagedHostConnection;
  sessionKey(entryId: EntryId): string;
  stop(): void;
}

export function startDemoHost(options: DemoHostOptions): DemoHost {
  unregisterConnection(LOCAL_HOST_ID);
  const transport = createMemoryTransport();
  const host = new FakeHost({
    transport,
    // A new instance id per run: the client treats it like a fresh server (no stale seqs).
    serverInstanceId: crypto.randomUUID(),
    hostState: options.hostState ?? sampleHostState(),
    summaries: options.summaries,
    sessions: options.sessions,
    onCommand: options.onCommand,
    replyToPrompts: options.replyToPrompts ?? false,
  });
  let reloadAt: number | null = null;
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    createTransport: () => transport,
    reload: () => undefined,
    reloadGuard: {
      read: () => reloadAt,
      write: (at) => {
        reloadAt = at;
      },
    },
    ...(options.immediate === true
      ? {
          scheduleFrame: (callback: () => void) => {
            callback();
          },
        }
      : {}),
  });
  registerConnection(connection);
  connection.start();
  if (options.select !== undefined) setSelectedSession(options.select, { updateHash: false });
  return {
    host,
    connection,
    sessionKey: (entryId) => makeSessionKey(LOCAL_HOST_ID, entryId),
    stop() {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    },
  };
}
