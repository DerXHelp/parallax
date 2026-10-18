import { LOCAL_HOST_ID } from '@shared/common';
import type { HostState, SessionSummary } from '@shared/model';
import type { Command } from '@shared/protocol';
import { sampleHostState } from '@shared/samples';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type ManagedHostConnection,
} from '@web/state/connection';
import { FakeHost, type FakeAck } from '@web/state/fake-host';
import { createMemoryTransport } from '@web/state/transport';
import { listDemoFolder } from './demo-folders';

/**
 * A FakeHost behind a real HostConnection on host `local` for the tests and playground demos of
 * WP-36 ("New session", folder browser, profile editor) – with own host state and command
 * handling, `fs.listDirectory` answered from the demo folder tree (demo-folders.ts). Dev/test
 * only: nothing in the app imports this module.
 */

export interface NewSessionDemoOptions {
  hostState?: HostState;
  summaries?: readonly SessionSummary[];
  /** Own command handling first; undefined → folder tree / FakeHost default. */
  onCommand?: (cmd: Command, host: FakeHost) => FakeAck | undefined;
  /** Ops are applied right away instead of once per animation frame (tests). */
  immediate?: boolean;
}

export interface NewSessionDemo {
  host: FakeHost;
  connection: ManagedHostConnection;
  /** Commands of one name received by the host, in order. */
  commands<N extends Command['name']>(name: N): Extract<Command, { name: N }>[];
  stop(): void;
}

export function startNewSessionDemo(options: NewSessionDemoOptions = {}): NewSessionDemo {
  unregisterConnection(LOCAL_HOST_ID);
  const transport = createMemoryTransport();
  const host = new FakeHost({
    transport,
    // A new instance id per run: the client treats it like a fresh server (no stale seqs).
    serverInstanceId: crypto.randomUUID(),
    hostState: options.hostState ?? sampleHostState(),
    summaries: options.summaries ?? [],
    onCommand: (cmd, fake) => {
      const own = options.onCommand?.(cmd, fake);
      if (own !== undefined) return own;
      if (cmd.name !== 'fs.listDirectory') return undefined;
      const result = listDemoFolder(cmd.path, cmd.showHidden);
      return result.ok ? { ok: true, result: result.listing } : { ok: false, error: result.error };
    },
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
  return {
    host,
    connection,
    commands: <N extends Command['name']>(name: N) =>
      host.commands.filter((cmd): cmd is Extract<Command, { name: N }> => cmd.name === name),
    stop() {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    },
  };
}
