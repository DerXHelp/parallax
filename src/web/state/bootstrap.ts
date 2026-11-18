import { LOCAL_HOST_ID } from '@shared/common';
import { hostWsPath } from '@shared/http';
import { WS_PATH } from '@shared/protocol';
import { startNotificationDelivery } from '@web/notifications/delivery';
import { getSystemNotifier, type SystemNotifier } from '@web/notifications/system';
import { consumeAuthCode, createAuthBootstrap, type FetchLike } from './auth';
import { createHostConnection, registerConnection, type ManagedHostConnection } from './connection';
import { startPresenceTracking } from './presence';
import { startRemoteHosts } from './remote-hosts';
import { clientStore } from './store';
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
 * through the Vite proxy – → handshake). Features reach it via `getConnection('local')` (registry
 * in connection.ts). WP-80: then one window connection per computer of the local
 * `HostState.remoteHosts` over this server's forwarder `hostWsPath(hostId)` (remote-hosts.ts) –
 * same origin, no `buildId` reload; computers come and go at runtime.
 */
export function bootApp(options: BootOptions = {}): BootedApp {
  const code = consumeAuthCode(window.location, window.history);
  const stopSelection = startSelectionSync();
  // WP22-03: the server needs to know whether this window can show Web Notifications.
  const stopPresence = startPresenceTracking(clientStore, window, {
    systemNotifications: () => (options.notifier ?? getSystemNotifier()).permission() === 'granted',
  });
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
  const stopRemoteHosts = startRemoteHosts({
    createTransport: (hostId) =>
      createWebSocketTransport(webSocketUrl(window.location, hostWsPath(hostId)), options.createSocket),
  });
  return {
    connection,
    dispose() {
      stopRemoteHosts();
      connection.stop();
      stopNotifications();
      stopPresence();
      stopSelection();
    },
  };
}
