import { describe, expect, it } from 'vitest';
import { KEY_STORE_ENTROPY_PREFIX, createDpapiKeyStore, loadDpapiNative, type DpapiNative } from './keyStore';
import { createMemoryKeyStore } from './memoryKeyStore';
import { KeyStoreError } from './ports';

async function failure(promise: Promise<unknown>): Promise<KeyStoreError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KeyStoreError) return error;
    throw error;
  }
  throw new Error('expected a KeyStoreError');
}

/** A fake DPAPI: "seals" by prefixing the entropy; records the calls (entropy copied before it is zeroed). */
function fakeNative(options: { fail?: boolean } = {}) {
  const calls: { op: string; entropy: string; data: Buffer }[] = [];
  const entropies: Buffer[] = [];
  const native: DpapiNative = {
    protect(data, entropy) {
      calls.push({ op: 'protect', entropy: entropy.toString('utf8'), data: Buffer.from(data) });
      entropies.push(entropy);
      if (options.fail === true) return null;
      return Buffer.concat([Buffer.from(`${entropy.toString('utf8')}|`), data]);
    },
    unprotect(data, entropy) {
      calls.push({ op: 'unprotect', entropy: entropy.toString('utf8'), data: Buffer.from(data) });
      entropies.push(entropy);
      const prefix = Buffer.from(`${entropy.toString('utf8')}|`);
      if (options.fail === true || !data.subarray(0, prefix.length).equals(prefix)) return null;
      return Buffer.from(data.subarray(prefix.length));
    },
  };
  return { native, calls, entropies };
}

describe('DPAPI key store (§B.5, ADR-228: node:ffi, no child process)', () => {
  it('binds every call to the purpose (entropy) and zeroes the entropy afterwards', async () => {
    const fake = fakeNative();
    const store = createDpapiKeyStore({ platform: 'win32', native: fake.native });
    const sealed = await store.protect('auth:peer', Buffer.from('secret-bytes'));
    expect((await store.unprotect('auth:peer', sealed)).toString()).toBe('secret-bytes');
    expect(fake.calls.map((call) => [call.op, call.entropy])).toEqual([
      ['protect', `${KEY_STORE_ENTROPY_PREFIX}auth:peer`],
      ['unprotect', `${KEY_STORE_ENTROPY_PREFIX}auth:peer`],
    ]);
    expect(fake.entropies.every((entropy) => entropy.every((byte) => byte === 0))).toBe(true);
    expect((await failure(store.unprotect('identity', sealed))).reason).toBe('failed');
  });

  it('maps a failed native call to KeyStoreError failed without data', async () => {
    const store = createDpapiKeyStore({ platform: 'win32', native: fakeNative({ fail: true }).native });
    const error = await failure(store.unprotect('identity', Buffer.from('xyz-secret')));
    expect(error.reason).toBe('failed');
    expect(error.message).not.toContain('xyz-secret');
    expect(await store.available()).toBe(false);
  });

  it('refuses invalid purposes and sizes before calling DPAPI', async () => {
    const fake = fakeNative();
    const store = createDpapiKeyStore({ platform: 'win32', native: fake.native });
    expect((await failure(store.protect('coupling:Bad Id', Buffer.from('k')))).reason).toBe('failed');
    expect((await failure(store.protect('identity', Buffer.alloc(0)))).reason).toBe('failed');
    expect((await failure(store.protect('identity', Buffer.alloc(64 * 1024 + 1)))).reason).toBe('failed');
    expect(fake.calls).toEqual([]);
  });

  it('probes once with a round trip and caches a working store', async () => {
    const fake = fakeNative();
    const store = createDpapiKeyStore({ platform: 'win32', native: fake.native });
    expect(await store.available()).toBe(true);
    expect(await store.available()).toBe(true);
    expect(fake.calls.map((call) => call.op)).toEqual(['protect', 'unprotect']);
  });

  it('is unavailable outside Windows or without node:ffi (never a clear-text fallback)', async () => {
    const linux = createDpapiKeyStore({ platform: 'linux' });
    expect(await linux.available()).toBe(false);
    expect((await failure(linux.protect('identity', Buffer.from('k')))).reason).toBe('unavailable');
    const withoutFfi = createDpapiKeyStore({ platform: 'win32', native: null });
    expect(await withoutFfi.available()).toBe(false);
    expect((await failure(withoutFfi.protect('identity', Buffer.from('k')))).reason).toBe('unavailable');
    expect(loadDpapiNative('linux')).toBeNull();
  });

  it.runIf(process.platform === 'win32' && process.arch === 'x64')(
    'real DPAPI: round trip, purpose binding and tamper detection (no file involved)',
    async () => {
      expect(loadDpapiNative()).not.toBeNull();
      const store = createDpapiKeyStore();
      expect(await store.available()).toBe(true);
      const secret = Buffer.from('parallax test secret 0123456789');
      const sealed = await store.protect('auth:peer', secret);
      expect(sealed.includes(secret)).toBe(false);
      expect((await store.unprotect('auth:peer', sealed)).equals(secret)).toBe(true);
      expect((await failure(store.unprotect('identity', sealed))).reason).toBe('failed');
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 3] = (tampered[tampered.length - 3] ?? 0) ^ 0x01;
      expect((await failure(store.unprotect('auth:peer', tampered))).reason).toBe('failed');
    },
  );
});

describe('memory key store (tests)', () => {
  it('round-trips per purpose, fails for foreign or tampered handles and holds no plaintext in the handle', async () => {
    const store = createMemoryKeyStore();
    const secret = Buffer.from('another secret');
    const sealed = await store.protect('identity', secret);
    expect(sealed.includes(secret)).toBe(false);
    expect((await store.unprotect('identity', sealed)).equals(secret)).toBe(true);
    expect((await failure(store.unprotect('coupling:x', sealed))).reason).toBe('failed');
    const tampered = Buffer.from(sealed);
    tampered[5] = (tampered[5] ?? 0) ^ 1;
    expect((await failure(store.unprotect('identity', tampered))).reason).toBe('failed');
    expect((await failure(createMemoryKeyStore().unprotect('identity', sealed))).reason).toBe('failed');
  });

  it('can be unavailable or fail once', async () => {
    const store = createMemoryKeyStore({ available: false });
    expect(await store.available()).toBe(false);
    expect((await failure(store.protect('identity', Buffer.from('k')))).reason).toBe('unavailable');
    store.setAvailable(true);
    store.failNext('timeout');
    expect((await failure(store.protect('identity', Buffer.from('k')))).reason).toBe('timeout');
    expect(await store.protect('identity', Buffer.from('k'))).toBeInstanceOf(Buffer);
  });
});
