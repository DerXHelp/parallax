import { createServer, type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { REMOTE_ACCESS_CHECK_IDS } from '@shared/model';
import { generateIdentity } from '../secure/identity';
import { createMemoryKeyStore } from '../secure/memoryKeyStore';
import { KeyStoreError } from '../secure/ports';
import { TEST_HOST } from '../secure/testKit';
import { keystoreCheck, probePort, runRemoteChecks, type RemoteCheckDeps } from './checks';

function deps(overrides: Partial<RemoteCheckDeps> = {}): RemoteCheckDeps {
  return {
    bindAddress: TEST_HOST,
    port: 0,
    ownListener: false,
    keyStore: createMemoryKeyStore(),
    identity: () => Promise.resolve(generateIdentity('identity')),
    selfTest: () => Promise.resolve(null),
    addresses: () => ['10.0.0.5'],
    probe: () => Promise.resolve('ok'),
    ...overrides,
  };
}

describe('checks when sharing is switched on (§4.2, §B.11)', () => {
  it('all fine → every check ok, in the order of REMOTE_ACCESS_CHECK_IDS, with the identity', async () => {
    const outcome = await runRemoteChecks(deps());
    expect(outcome.checks.map((check) => check.id)).toEqual([...REMOTE_ACCESS_CHECK_IDS]);
    expect(outcome.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(outcome.identity?.purpose).toBe('identity');
    expect(outcome.error).toBeNull();
  });

  it('missing key store → keystore/keys error and REMOTE_KEYSTORE_UNAVAILABLE (no key is created)', async () => {
    let created = 0;
    const outcome = await runRemoteChecks(
      deps({
        keyStore: createMemoryKeyStore({ available: false }),
        identity: () => {
          created += 1;
          return Promise.resolve(generateIdentity('identity'));
        },
      }),
    );
    expect(created).toBe(0);
    expect(outcome.error?.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
    expect(outcome.checks.find((check) => check.id === 'keystore')?.status).toBe('error');
    expect(outcome.checks.find((check) => check.id === 'keys')).toMatchObject({
      status: 'error',
      params: { reason: 'keystore' },
    });
  });

  it('a failing self-test → tls error and REMOTE_ACCESS_FAILED tls_unsupported', async () => {
    const outcome = await runRemoteChecks(deps({ selfTest: () => Promise.resolve('handshake') }));
    expect(outcome.error).toMatchObject({
      code: 'REMOTE_ACCESS_FAILED',
      params: { reason: 'tls_unsupported' },
    });
    expect(outcome.checks.find((check) => check.id === 'tls')).toMatchObject({
      status: 'error',
      params: { step: 'handshake' },
    });
  });

  it('port in use, key store failure while loading, no addresses', async () => {
    const outcome = await runRemoteChecks(
      deps({
        probe: () => Promise.resolve('port_in_use'),
        identity: () => Promise.reject(new KeyStoreError('timeout')),
        addresses: () => [],
      }),
    );
    const byId = Object.fromEntries(outcome.checks.map((check) => [check.id, check]));
    expect(byId.port).toMatchObject({ status: 'error', params: { reason: 'port_in_use' } });
    expect(byId.keys).toMatchObject({ status: 'error', params: { reason: 'keystore' } });
    expect(byId.addresses).toMatchObject({ status: 'warning', params: { count: 0 } });
    expect(byId).not.toHaveProperty('firewall');
    expect(outcome.error?.code).toBe('REMOTE_KEYSTORE_UNAVAILABLE');
  });

  it('the own running listener counts as a free port (no probe)', async () => {
    let probed = 0;
    const outcome = await runRemoteChecks(
      deps({
        ownListener: true,
        probe: () => {
          probed += 1;
          return Promise.resolve('port_in_use');
        },
      }),
    );
    expect(probed).toBe(0);
    expect(outcome.checks[0]?.status).toBe('ok');
  });

  it('probePort sees a taken port on 127.0.0.1', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen({ host: TEST_HOST, port: 0 }, resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await probePort(TEST_HOST, port)).toBe('port_in_use');
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
    expect(await probePort(TEST_HOST, port)).toBe('ok');
  });
});

describe('key store check per scheme (WP-107, §B.14)', () => {
  it('Windows unchanged; Linux names its scheme; the file is a warning with params.scheme', () => {
    expect(keystoreCheck(true, undefined)).toEqual({ id: 'keystore', status: 'ok', params: {} });
    expect(keystoreCheck(true, 'dpapi')).toEqual({ id: 'keystore', status: 'ok', params: {} });
    expect(keystoreCheck(true, 'systemd_creds')).toEqual({
      id: 'keystore',
      status: 'ok',
      params: { scheme: 'systemd_creds' },
    });
    expect(keystoreCheck(true, 'file')).toEqual({
      id: 'keystore',
      status: 'warning',
      params: { scheme: 'file' },
    });
    expect(keystoreCheck(false, 'secret_service')).toMatchObject({ id: 'keystore', status: 'error' });
  });
});
