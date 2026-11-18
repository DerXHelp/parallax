import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_CLOSE } from '@shared/protocol';
import { SAMPLE_IDS, SAMPLE_REMOTE_HOST_ID, sampleHello } from '@shared/samples';
import { createHostConnection, type HostConnectionOptions } from './connection';
import { createClientStore } from './store';
import { createMemoryTransport } from './transport';

/**
 * WP-80: the window connection to another computer (`remote: true`) and the close codes of the
 * forwarder (4502 unreachable, 4410 incompatible, 4403 coupling revoked) – never a reload, never
 * a loop.
 */

const HOST = SAMPLE_REMOTE_HOST_ID;

function setup(options: Partial<HostConnectionOptions> = {}) {
  const store = createClientStore();
  const transports: ReturnType<typeof createMemoryTransport>[] = [];
  const reload = vi.fn();
  const connection = createHostConnection({
    hostId: HOST,
    store,
    remote: true,
    createTransport: () => {
      const transport = createMemoryTransport();
      transports.push(transport);
      return transport;
    },
    reload,
    reloadGuard: { read: () => null, write: () => undefined },
    clientId: SAMPLE_IDS.client,
    buildId: 'dev',
    random: () => 0.5,
    scheduleFrame: (callback) => {
      callback();
    },
    ...options,
  });
  const current = () => {
    const transport = transports.at(-1);
    if (transport === undefined) throw new Error('no transport');
    return transport;
  };
  const host = () => store.getState().hosts[HOST];
  return { store, transports, current, connection, reload, host };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('remote window connection', () => {
  it('connects without an auth check and never compares the build id (no reload)', () => {
    const { current, connection, reload, host } = setup();
    connection.start();
    current().serverSend(sampleHello({ buildId: 'other-build' }));
    expect(connection.status()).toBe('open');
    expect(host()?.phase).toBe('open');
    expect(reload).not.toHaveBeenCalled();
  });

  it('4502: unreachable → reconnect with backoff, commands fail at once until the next hello', async () => {
    const { transports, current, connection, host } = setup();
    connection.start();
    current().serverSend(sampleHello());
    const open = connection.send({ name: 'session.interrupt', entryId: SAMPLE_IDS.entry });
    current().serverClose(WS_CLOSE.HOST_UNREACHABLE);
    await expect(open).rejects.toMatchObject({ code: 'HOST_UNREACHABLE' });
    expect(host()?.phase).toBe('reconnecting');
    expect(host()?.error?.code).toBe('HOST_UNREACHABLE');
    expect(host()?.nextAttemptAt).not.toBeNull();

    // Meanwhile a command does not wait for the connection: it fails at once.
    await expect(
      connection.send({ name: 'session.interrupt', entryId: SAMPLE_IDS.entry }),
    ).rejects.toMatchObject({
      code: 'HOST_UNREACHABLE',
    });

    // The backoff runs: a new transport, and after its hello commands go out again.
    vi.advanceTimersByTime(1000);
    expect(transports).toHaveLength(2);
    current().serverSend(sampleHello());
    expect(connection.status()).toBe('open');
    void connection.send({ name: 'session.interrupt', entryId: SAMPLE_IDS.entry }).catch(() => undefined);
    expect(current().sentOfType('cmd')).toHaveLength(1);
  });

  it('4410: incompatible – no reload, no further attempts, commands rejected; retryNow tries again', async () => {
    const { transports, current, connection, reload, host } = setup();
    connection.start();
    current().serverSend(sampleHello());
    current().serverClose(WS_CLOSE.HOST_INCOMPATIBLE);
    expect(host()?.phase).toBe('incompatible');
    expect(host()?.status).toBe('closed');
    expect(host()?.error?.code).toBe('HOST_INCOMPATIBLE');
    vi.advanceTimersByTime(10 * 60_000);
    expect(transports).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    await expect(
      connection.send({ name: 'session.interrupt', entryId: SAMPLE_IDS.entry }),
    ).rejects.toMatchObject({
      code: 'HOST_INCOMPATIBLE',
    });
    connection.retryNow();
    expect(transports).toHaveLength(2);
  });

  it('another protocol in hello counts as incompatible (ADR-209), never as a version mismatch', () => {
    const { transports, current, connection, reload, host } = setup();
    connection.start();
    current().serverSend(sampleHello({ protocolVersion: 999, serverVersion: '9.9.9' }));
    expect(host()?.phase).toBe('incompatible');
    expect(host()?.error).toEqual({ code: 'HOST_INCOMPATIBLE', params: { protocol: 999, version: '9.9.9' } });
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * 60_000);
    expect(transports).toHaveLength(1);
  });

  it('4403: revoked – closed until retryNow, commands rejected with HOST_REVOKED', async () => {
    const { transports, current, connection, host } = setup();
    connection.start();
    current().serverSend(sampleHello());
    const pending = connection.send({ name: 'session.interrupt', entryId: SAMPLE_IDS.entry });
    current().serverClose(WS_CLOSE.HOST_REVOKED);
    await expect(pending).rejects.toMatchObject({ code: 'HOST_REVOKED' });
    expect(host()?.phase).toBe('revoked');
    vi.advanceTimersByTime(10 * 60_000);
    expect(transports).toHaveLength(1);
    await expect(
      connection.send({ name: 'session.interrupt', entryId: SAMPLE_IDS.entry }),
    ).rejects.toMatchObject({
      code: 'HOST_REVOKED',
    });
  });

  it('the local connection keeps treating these codes as a lost connection', () => {
    const { current, connection, host } = setup({ remote: false, homeHost: false });
    connection.start();
    current().serverSend(sampleHello());
    current().serverClose(WS_CLOSE.HOST_REVOKED);
    expect(host()?.phase).toBe('reconnecting');
    expect(host()?.error?.code).toBe('CONNECTION_LOST');
  });
});
