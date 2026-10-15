import { LOCAL_HOST_ID } from '@shared/common';
import { WS_PATH } from '@shared/protocol';
import { startNotificationDelivery } from '@web/notifications/delivery';
import type { SystemNotifier } from '@web/notifications/system';
import { consumeAuthCode, createAuthBootstrap, type FetchLike } from './auth';
import { createHostConnection, registerConnection, type ManagedHostConnection } from './connection';
import { startPresenceTracking } from './presence';
import { startSelectionSync } from './selection';
import { createWebSocketTransport, webSocketUrl, type SocketFactory } from './transport';

export interface BootOptions {
  fetch?: FetchLike;
  createSocket?: SocketFactory;
  /** Web Notifications (tests inject a fake; default: the browser API). */
  notifier?: SystemNotifier;
  /** Default `window.location.reload()` (version mismatch, WP-02 §7.1). */
  reload?: () => void;
}

export interface BootedApp {
  connection: ManagedHostConnection;
  /** Stops the connection and removes the window listeners (tests). */
  dispose(): void;
}

/**
 * App start (main.tsx), in this order: take the auth code out of the URL (before anything reads
 * the hash), selection from `#session=`, presence tracking, notification delivery, then the local
 * host connection (auth status → WS `ws://<location.host>/api/ws` of the same origin – in dev
 * through the Vite proxy – → handshake). Phase 1 has exactly the host `local`; features reach it
 * via `getConnection('local')` (registry in connection.ts).
 */
export function bootApp(options: BootOptions = {}): BootedApp {
  const code = consumeAuthCode(window.location, window.history);
  const stopSelection = startSelectionSync();
  const stopPresence = startPresenceTracking();
  const stopNotifications = startNotificationDelivery(
    options.notifier === undefined ? {} : { notifier: options.notifier },
  );
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const auth = createAuthBootstrap({ code, fetch: fetchFn });
  const url = webSocketUrl(window.location, WS_PATH);
  const connection = createHostConnection({
    hostId: LOCAL_HOST_ID,
    homeHost: true,
    createTransport: () => createWebSocketTransport(url, options.createSocket),
    checkAuth: () => auth.check(),
    ...(options.reload === undefined ? {} : { reload: options.reload }),
  });
  registerConnection(connection);
  connection.start();
  return {
    connection,
    dispose() {
      connection.stop();
      stopNotifications();
      stopPresence();
      stopSelection();
    },
  };
}
