import { LOCAL_HOST_ID } from '@shared/common';
import { WS_PATH } from '@shared/protocol';
import { consumeAuthCode, createAuthBootstrap, type FetchLike } from './auth';
import { createHostConnection, registerConnection, type ManagedHostConnection } from './connection';
import { startPresenceTracking } from './presence';
import { startSelectionSync } from './selection';
import { createWebSocketTransport, webSocketUrl, type SocketFactory } from './transport';

export interface BootOptions {
  fetch?: FetchLike;
  createSocket?: SocketFactory;
}

export interface BootedApp {
  connection: ManagedHostConnection;
  /** Stops the connection and removes the window listeners (tests). */
  dispose(): void;
}

/**
 * App start (main.tsx), in this order: take the auth code out of the URL (before anything reads
 * the hash), selection from `#session=`, presence tracking, then the local host connection
 * (auth status → WS → handshake). Phase 1 has exactly the host `local`.
 */
export function bootApp(options: BootOptions = {}): BootedApp {
  const code = consumeAuthCode(window.location, window.history);
  const stopSelection = startSelectionSync();
  const stopPresence = startPresenceTracking();
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const auth = createAuthBootstrap({ code, fetch: fetchFn });
  const url = webSocketUrl(window.location, WS_PATH);
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    homeHost: true,
    createTransport: () => createWebSocketTransport(url, options.createSocket),
    checkAuth: () => auth.check(),
  });
  registerConnection(connection);
  connection.start();
  return {
    connection,
    dispose() {
      connection.stop();
      stopPresence();
      stopSelection();
    },
  };
}
