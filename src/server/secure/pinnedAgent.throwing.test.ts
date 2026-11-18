import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateIdentity } from './identity';
import type * as PinsModule from './pins';
import { PinnedAgent, PinnedConnectionError } from './pinnedAgent';
import { TEST_HOST, identityCredentials, startTlsServer } from './testKit';

/** Review A2 / t2(b): a throwing pin comparison must reject, never become an uncaughtException. */
const control = vi.hoisted(() => ({ throwing: false }));

vi.mock('./pins', async (importOriginal) => {
  const original = await importOriginal<typeof PinsModule>();
  return {
    ...original,
    pinsEqual: (a: string, b: string) => {
      if (control.throwing) throw new Error('comparison exploded');
      return original.pinsEqual(a, b);
    },
  };
});

const serverIdentity = generateIdentity('identity');
const clientIdentity = generateIdentity('coupling:pc-b');
let tls: Awaited<ReturnType<typeof startTlsServer>>;
const accepted: unknown[] = [];
const uncaught: unknown[] = [];
const onUncaught = (error: unknown): void => {
  uncaught.push(error);
};

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  tls = await startTlsServer(
    { ...identityCredentials(serverIdentity), requestCert: true, rejectUnauthorized: false },
    (socket) => {
      accepted.push(socket);
      socket.on('data', () => accepted.push('data'));
    },
  );
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  await tls.close();
});

describe('PinnedAgent with a throwing pin comparison', () => {
  it('refuses the connection, sends no application data and throws nothing uncaught', async () => {
    const agent = new PinnedAgent({
      identity: clientIdentity,
      peerCertificateDer: serverIdentity.certificateDer,
      peerPin: serverIdentity.pin,
      authKey: randomBytes(48),
      connectTimeoutMs: 3_000,
      proofTimeoutMs: 3_000,
    });
    control.throwing = true;
    try {
      const error = await new Promise<unknown>((resolve) => {
        const req = request({ host: TEST_HOST, port: tls.port, path: '/remote/v1/health', agent }, () => {
          resolve(new Error('unexpected response'));
        });
        req.on('error', resolve);
        req.end();
      });
      expect(error).toBeInstanceOf(PinnedConnectionError);
      expect(accepted.filter((entry) => entry === 'data')).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      control.throwing = false;
      agent.destroy();
    }
  });
});
