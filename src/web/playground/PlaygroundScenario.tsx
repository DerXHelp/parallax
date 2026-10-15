import { useEffect, type ReactNode } from 'react';
import { LOCAL_HOST_ID } from '@shared/common';
import {
  createHostConnection,
  registerConnection,
  unregisterConnection,
  type ManagedHostConnection,
} from '@web/state/connection';
import { FakeHost } from '@web/state/fake-host';
import { setSelectedSession } from '@web/state/selection';
import { selectSettings } from '@web/state/settings';
import { clientStore, resetClientStore, type ClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { SCENARIOS, type ScenarioId } from './scenarios';

export interface RunningScenario {
  host: FakeHost;
  connection: ManagedHostConnection;
  stop(): void;
}

/**
 * Starts a scenario as host `local`: fresh store (the window's settings are kept), FakeHost over
 * a MemoryTransport, a real HostConnection (same code path as the app), optional selection.
 */
export function startScenario(
  id: ScenarioId,
  options: { select?: string | null; store?: ClientStore } = {},
): RunningScenario {
  const store = options.store ?? clientStore;
  const scenario = SCENARIOS[id];
  const settings = selectSettings(store.getState());
  unregisterConnection(LOCAL_HOST_ID);
  resetClientStore(store);
  store.setState({ localSettings: settings });

  const transport = createMemoryTransport();
  const host = new FakeHost({ transport, replyToPrompts: true, ...scenario.build(Date.now(), settings) });
  const auth = scenario.auth;
  let reloadAt: number | null = null;
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    store,
    createTransport: () => transport,
    checkAuth: auth === undefined ? undefined : () => Promise.resolve(auth),
    reload: () => undefined,
    reloadGuard: {
      read: () => reloadAt,
      write: (at) => {
        reloadAt = at;
      },
    },
  });
  registerConnection(connection);
  connection.start();
  const select = options.select === undefined ? scenario.select : options.select;
  setSelectedSession(select, { store, updateHash: false });
  const stopLive = scenario.start?.(host, Date.now);
  return {
    host,
    connection,
    stop() {
      stopLive?.();
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    },
  };
}

/**
 * Runs a scenario while mounted, for playground demos (also usable by WP-15/16 demos):
 * `<PlaygroundScenario scenario="streaming"><TranscriptView sessionKey={PLAYGROUND_SESSION_KEYS.streaming} /></PlaygroundScenario>`.
 */
export function PlaygroundScenario({
  scenario,
  select,
  children,
}: {
  scenario: ScenarioId;
  select?: string | null;
  children: ReactNode;
}) {
  useEffect(() => {
    const running = startScenario(scenario, { select });
    return () => {
      running.stop();
    };
  }, [scenario, select]);
  return children;
}
