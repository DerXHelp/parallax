/**
 * The checks of `remoteAccess.check` and of switching "Share" on (docs/wp/WP-75.md §4.2,
 * WP-76 §B.11): port, keys, key store, TLS (self-test), addresses – always in the order of
 * REMOTE_ACCESS_CHECK_IDS. `error` blocks the listener; `warning` is a hint only. Nothing here
 * starts a process (ADR-228: no firewall query – the user sets up the Windows Firewall).
 */
import { createServer } from 'node:net';
import { makeError, type ErrorPayload } from '@shared/errors';
import { REMOTE_ACCESS_CHECK_IDS, type RemoteAccessCheck } from '@shared/model';
import { fsErrorCode } from '../lib/paths';
import { KeyStoreError, type Identity, type KeyStore } from '../secure/ports';
import type { SelfTestFailure } from '../secure/selfTest';

export type PortProbe = 'ok' | 'port_in_use' | 'bind';

/** Tries to bind `address:port` and closes again at once. */
export function probePort(address: string, port: number): Promise<PortProbe> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => {
      resolve(fsErrorCode(error) === 'EADDRINUSE' ? 'port_in_use' : 'bind');
    });
    server.listen({ host: address, port, exclusive: true }, () => {
      server.close(() => {
        resolve('ok');
      });
    });
  });
}

export interface RemoteCheckDeps {
  bindAddress: string;
  port: number;
  /** The own listener already runs on exactly this address and port → `port` is ok without a probe. */
  ownListener: boolean;
  keyStore: KeyStore;
  /** Loads or creates the identity key (throws KeyStoreError or another error). */
  identity: () => Promise<Identity>;
  selfTest: () => Promise<SelfTestFailure | null>;
  addresses: () => string[];
  probe?: (address: string, port: number) => Promise<PortProbe>;
}

export interface RemoteCheckResult {
  checks: RemoteAccessCheck[];
  identity: Identity | null;
  /** The first blocking problem as the error of the listener (null = may listen). */
  error: ErrorPayload | null;
}

function check(
  id: RemoteAccessCheck['id'],
  status: RemoteAccessCheck['status'],
  params: RemoteAccessCheck['params'] = {},
): RemoteAccessCheck {
  return { id, status, params };
}

export async function runRemoteChecks(deps: RemoteCheckDeps): Promise<RemoteCheckResult> {
  const probe = deps.probe ?? probePort;
  const port = deps.ownListener ? Promise.resolve<PortProbe>('ok') : probe(deps.bindAddress, deps.port);
  const selfTest = deps.selfTest().catch((): SelfTestFailure => 'handshake');
  const available = await deps.keyStore.available().catch(() => false);

  let identity: Identity | null = null;
  let keys: RemoteAccessCheck;
  if (!available) {
    keys = check('keys', 'error', { reason: 'keystore' });
  } else {
    try {
      identity = await deps.identity();
      keys = check('keys', 'ok');
    } catch (error) {
      keys = check('keys', 'error', { reason: error instanceof KeyStoreError ? 'keystore' : 'store' });
    }
  }
  const portResult = await port;
  const selfTestResult = await selfTest;
  const addresses = deps.addresses();

  const results: Record<RemoteAccessCheck['id'], RemoteAccessCheck> = {
    port:
      portResult === 'ok'
        ? check('port', 'ok', { port: deps.port })
        : check('port', 'error', { port: deps.port, reason: portResult }),
    keys,
    keystore: available ? check('keystore', 'ok') : check('keystore', 'error'),
    tls:
      selfTestResult === null
        ? check('tls', 'ok')
        : check('tls', 'error', { reason: 'tls_unsupported', step: selfTestResult }),
    addresses:
      addresses.length > 0
        ? check('addresses', 'ok', { count: addresses.length })
        : check('addresses', 'warning', { count: 0 }),
  };
  const checks = REMOTE_ACCESS_CHECK_IDS.map((id) => results[id]);

  let error: ErrorPayload | null = null;
  if (!available) error = makeError('REMOTE_KEYSTORE_UNAVAILABLE');
  else if (selfTestResult !== null) error = makeError('REMOTE_ACCESS_FAILED', { reason: 'tls_unsupported' });
  else if (keys.status === 'error') {
    error =
      keys.params.reason === 'keystore'
        ? makeError('REMOTE_KEYSTORE_UNAVAILABLE')
        : makeError('REMOTE_ACCESS_FAILED', { reason: 'store' });
  } else if (portResult !== 'ok') error = makeError('REMOTE_ACCESS_FAILED', { reason: portResult });
  return { checks, identity, error };
}
