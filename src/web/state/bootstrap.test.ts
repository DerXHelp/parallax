import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { API_PATHS } from '@shared/http';
import { WS_PATH, parseClientMessage, type ClientMessage } from '@shared/protocol';
import {
  sampleAuthStatus,
  sampleHostState,
  sampleHello,
  sampleId,
  sampleSummary,
  sampleTime,
  sampleToken,
} from '@shared/samples';
import type { SystemNotifier } from '@web/notifications/system';
import type { FetchLike } from './auth';
import { bootApp, type BootedApp } from './bootstrap';
import { getConnection, unregisterConnection } from './connection';
import { clientStore, resetClientStore } from './store';
import type { SocketFactory, SocketHandlers } from './transport';

/**
 * bootApp end to end without a server (WP-20b): auth bootstrap (`#code=` → POST /api/auth →
 * replaceState → GET /api/auth/status), the WebSocket of the same origin, handshake with presence,
 * presence tracking of the window and the notification delivery.
 */

const CODE = sampleToken(7);
const ENTRY = sampleId('en', 1);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(handlers: Record<string, () => Response>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchFn: FetchLike = (url, init) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const handler = handlers[url];
    return handler === undefined
      ? Promise.reject(new TypeError('network error'))
      : Promise.resolve(handler());
  };
  return { calls, fetchFn };
}

interface FakeSocket {
  url: string;
  handlers: SocketHandlers;
  open: boolean;
  sent: ClientMessage[];
  /** Delivers a server message. */
  receive(message: unknown): void;
}

function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (url, handlers) => {
    const socket: FakeSocket = {
      url,
      handlers,
      open: true,
      sent: [],
      receive: (message) => {
        handlers.onMessage(JSON.stringify(message));
      },
    };
    sockets.push(socket);
    return {
      get isOpen() {
        return socket.open;
      },
      send: (text) => {
        const parsed = parseClientMessage(text);
        if (!parsed.ok) throw new Error('invalid client message');
        socket.sent.push(parsed.message);
      },
      close: () => {
        socket.open = false;
      },
    };
  };
  return { sockets, factory };
}

function quietNotifier(): SystemNotifier & { shown: string[] } {
  const shown: string[] = [];
  return {
    shown,
    permission: () => 'granted',
    requestPermission: () => Promise.resolve('granted'),
    show(options) {
      shown.push(options.title);
      return { close: () => undefined };
    },
  };
}

let booted: BootedApp | null = null;

afterEach(() => {
  booted?.dispose();
  booted = null;
  unregisterConnection(LOCAL_HOST_ID);
  resetClientStore();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('bootApp (auth bootstrap + WebSocket of the local host)', () => {
  it('exchanges #code= for the cookie, removes it from the URL at once, then opens ws://<host>/api/ws', async () => {
    window.history.replaceState(null, '', `/#code=${CODE}&session=${KEY}`);
    const { calls, fetchFn } = fakeFetch({
      [API_PATHS.auth]: () => json(200, sampleAuthStatus()),
      [API_PATHS.authStatus]: () => json(200, sampleAuthStatus()),
    });
    const { sockets, factory } = fakeSockets();
    booted = bootApp({
      fetch: fetchFn,
      createSocket: factory,
      notifier: quietNotifier(),
      reload: () => undefined,
    });

    // Step 1 (synchronous): the code is gone from the URL, the rest of the hash stays.
    expect(window.location.hash).toBe(`#session=${KEY}`);
    expect(window.location.href).not.toContain(CODE);
    expect(clientStore.getState().selectedSession).toBe(KEY);

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(calls).toEqual([
      { url: API_PATHS.auth, method: 'POST', body: { code: CODE } },
      { url: API_PATHS.authStatus, method: 'GET', body: null },
    ]);
    expect(sockets[0]?.url).toBe(`ws://${window.location.host}${WS_PATH}`);

    // Handshake: clientHello with the presence of this window (viewing the selected entry).
    sockets[0]?.receive(sampleHello());
    expect(sockets[0]?.sent[0]).toMatchObject({
      type: 'clientHello',
      protocolVersion: 1,
      buildId: 'dev',
      presence: { viewingEntryId: ENTRY, typing: false },
    });
    expect(getConnection(LOCAL_HOST_ID).status()).toBe('open');
    sockets[0]?.receive({ type: 'host.state', host: sampleHostState() });
    sockets[0]?.receive({ type: 'summaries.snapshot', summaries: [sampleSummary({ entryId: ENTRY })] });
    expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.summariesLoaded).toBe(true);
  });

  it('shows "not signed in" without a WebSocket when the code was rejected', async () => {
    window.history.replaceState(null, '', `/#code=${CODE}`);
    const { calls, fetchFn } = fakeFetch({
      [API_PATHS.auth]: () => json(401, { code: 'AUTH_CODE_INVALID', params: {} }),
      [API_PATHS.authStatus]: () => json(200, sampleAuthStatus({ authenticated: false })),
    });
    const { sockets, factory } = fakeSockets();
    booted = bootApp({ fetch: fetchFn, createSocket: factory, notifier: quietNotifier() });
    expect(window.location.hash).toBe('');
    await waitFor(() => {
      expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.phase).toBe('unauthenticated');
    });
    expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.authCodeRejected).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([API_PATHS.auth, API_PATHS.authStatus]);
    expect(sockets).toHaveLength(0);
  });

  it('without a code only asks the status (existing cookie)', async () => {
    const { calls, fetchFn } = fakeFetch({ [API_PATHS.authStatus]: () => json(200, sampleAuthStatus()) });
    const { sockets, factory } = fakeSockets();
    booted = bootApp({ fetch: fetchFn, createSocket: factory, notifier: quietNotifier() });
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    expect(calls.map((call) => call.url)).toEqual([API_PATHS.authStatus]);
  });

  it('reports focus, visibility and the shown session as presence (debounced)', async () => {
    const { fetchFn } = fakeFetch({ [API_PATHS.authStatus]: () => json(200, sampleAuthStatus()) });
    const { sockets, factory } = fakeSockets();
    booted = bootApp({ fetch: fetchFn, createSocket: factory, notifier: quietNotifier() });
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.receive(sampleHello());
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    clientStore.setState({ selectedSession: KEY });
    await waitFor(() => {
      expect(socket.sent.filter((message) => message.type === 'presence')).toEqual([
        {
          type: 'presence',
          // WP22-03: whether this window can show Web Notifications (the fake notifier says granted).
          presence: {
            focused: false,
            visible: true,
            viewingEntryId: ENTRY,
            typing: false,
            systemNotifications: true,
          },
        },
      ]);
    });
  });

  it('delivers server notifications (unfocused window → Web Notification)', async () => {
    const notifier = quietNotifier();
    const { fetchFn } = fakeFetch({ [API_PATHS.authStatus]: () => json(200, sampleAuthStatus()) });
    const { sockets, factory } = fakeSockets();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    booted = bootApp({ fetch: fetchFn, createSocket: factory, notifier });
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.receive(sampleHello());
    sockets[0]?.receive({
      type: 'notify',
      notification: {
        id: 'n1',
        kind: 'done',
        entryId: ENTRY,
        title: 'Auth service',
        delivery: 'system',
        at: sampleTime(),
      },
    });
    expect(notifier.shown).toEqual(['Auth service – done']);
  });
});
