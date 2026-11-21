/**
 * WP-107 (docs/wp/WP-76.md §B.14): the Linux key stores – only with test doubles (a fake
 * `systemd-creds` runner, a fake Secret Service, a worker that never answers). Never the keyring or
 * the credentials of this computer.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFileKeyStore } from './fileKeyStore';
import { createMemoryKeyStore } from './memoryKeyStore';
import { createPlatformKeyStore, linuxSchemeOrder } from './platformKeyStore';
import { KeyStoreError, type KeyStore } from './ports';
import {
  createSecretServiceKeyStore,
  createSecretServiceWorker,
  openWithKey,
  sealWithKey,
  type SecretServiceNative,
} from './secretServiceKeyStore';
import { createSystemdCredsKeyStore, credentialName, type CredsRunner } from './systemdCredsKeyStore';

const SECRET = Buffer.from('a 32 byte secret of the coupling');

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof KeyStoreError ? error.reason : 'other';
  }
  return 'resolved';
}

describe('file key store (opt-in, §B.14)', () => {
  it('Linux only: the secret behind a marker; a foreign value fails', async () => {
    const store = createFileKeyStore({ platform: 'linux' });
    expect(store.scheme).toBe('file');
    expect(await store.available()).toBe(true);
    const sealed = await store.protect('identity', SECRET);
    expect(await store.unprotect('identity', sealed)).toEqual(SECRET);
    expect(await reason(store.unprotect('identity', Buffer.from('dpapi blob')))).toBe('failed');
    expect(await reason(store.protect('identity', Buffer.alloc(0)))).toBe('failed');
    const windows = createFileKeyStore({ platform: 'win32' });
    expect(await windows.available()).toBe(false);
    expect(await reason(windows.protect('identity', SECRET))).toBe('unavailable');
  });
});

describe('systemd-creds --user (§B.14)', () => {
  /** A fake systemd-creds: "encrypts" by prefixing the credential name; records the arguments. */
  function fakeCreds(p: { exit?: number | null; timedOut?: boolean } = {}) {
    const calls: { args: readonly string[]; input: string }[] = [];
    const run: CredsRunner = (args, input) => {
      calls.push({ args, input: input.toString('hex') });
      const name = args.find((arg) => arg.startsWith('--name='))?.slice(7) ?? '';
      const prefix = Buffer.from(`${name}|`);
      const out = args[0] === 'encrypt' ? Buffer.concat([prefix, input]) : input.subarray(prefix.length);
      return Promise.resolve({
        exitCode: p.exit === undefined ? 0 : p.exit,
        stdout: out,
        timedOut: p.timedOut ?? false,
      });
    };
    return { run, calls };
  }

  it('the secret only over stdin/stdout, the purpose in the credential name', async () => {
    const creds = fakeCreds();
    const store = createSystemdCredsKeyStore({ platform: 'linux', run: creds.run });
    expect(store.scheme).toBe('systemd_creds');
    const sealed = await store.protect('coupling:pc-b', SECRET);
    expect(await store.unprotect('coupling:pc-b', sealed)).toEqual(SECRET);
    expect(creds.calls[0]?.args).toEqual(['encrypt', '--user', '--name=parallax-coupling-pc-b', '-', '-']);
    // Never the secret in an argument.
    for (const call of creds.calls) expect(call.args.join(' ')).not.toContain(SECRET.toString('utf8'));
    expect(credentialName('identity')).toBe('parallax-identity');
  });

  it('available() probes encrypt + decrypt; a failing or hanging tool is unavailable / timeout', async () => {
    expect(await createSystemdCredsKeyStore({ platform: 'linux', run: fakeCreds().run }).available()).toBe(
      true,
    );
    const missing = createSystemdCredsKeyStore({ platform: 'linux', run: fakeCreds({ exit: null }).run });
    expect(await missing.available()).toBe(false);
    expect(await reason(missing.protect('identity', SECRET))).toBe('unavailable');
    const failing = createSystemdCredsKeyStore({ platform: 'linux', run: fakeCreds({ exit: 1 }).run });
    expect(await reason(failing.protect('identity', SECRET))).toBe('failed');
    const hanging = createSystemdCredsKeyStore({ platform: 'linux', run: fakeCreds({ timedOut: true }).run });
    expect(await reason(hanging.protect('identity', SECRET))).toBe('timeout');
    const windows = createSystemdCredsKeyStore({ platform: 'win32', run: fakeCreds().run });
    expect(await windows.available()).toBe(false);
  });
});

describe('Secret Service (libsecret in a worker, §B.14)', () => {
  function fakeKeyring(
    p: { probe?: boolean } = {},
  ): SecretServiceNative & { items: Map<string, string>; locked: boolean } {
    const items = new Map<string, string>();
    const keyring = {
      items,
      /** A locked keyring: lookups find nothing, a store opens it (the prompt was confirmed). */
      locked: false,
      lookup: (purpose: string) => Promise.resolve(keyring.locked ? null : (items.get(purpose) ?? null)),
      exists: (purpose: string) => Promise.resolve(items.has(purpose)),
      store: (purpose: string, secret: string) => {
        items.set(purpose, secret);
        keyring.locked = false;
        return Promise.resolve();
      },
      probe: () => (p.probe === false ? Promise.reject(new KeyStoreError('unavailable')) : Promise.resolve()),
      close: () => undefined,
    };
    return keyring;
  }

  it('a locked keyring never gets a new key in place of the stored one (review WP-109)', async () => {
    const keyring = fakeKeyring();
    const store = createSecretServiceKeyStore({ platform: 'linux', native: keyring });
    const sealed = await store.protect('auth:peer', SECRET);
    const key = keyring.items.get('auth:peer');
    keyring.locked = true;
    expect(await reason(store.protect('auth:peer', SECRET))).toBe('unavailable');
    expect(keyring.items.get('auth:peer')).toBe(key);
    expect(await reason(store.unprotect('auth:peer', sealed))).toBe('failed');
    // Open again: the old values still open.
    keyring.locked = false;
    expect(await store.unprotect('auth:peer', sealed)).toEqual(SECRET);
  });

  it('one random AES key per purpose in the keyring; the file holds only the sealed value', async () => {
    const keyring = fakeKeyring();
    const store = createSecretServiceKeyStore({ platform: 'linux', native: keyring });
    expect(store.scheme).toBe('secret_service');
    expect(await store.available()).toBe(true);
    const sealed = await store.protect('identity', SECRET);
    expect(sealed.includes(SECRET)).toBe(false);
    expect(keyring.items.has('identity')).toBe(true);
    expect(await store.unprotect('identity', sealed)).toEqual(SECRET);
    // Bound to the purpose: another purpose (another key and AAD) cannot open it.
    await store.protect('coupling:pc-b', SECRET);
    expect(await reason(store.unprotect('coupling:pc-b', sealed))).toBe('failed');
    // A lost keyring item: the value cannot be opened, no new key is made for reading.
    keyring.items.delete('identity');
    expect(await reason(store.unprotect('identity', sealed))).toBe('failed');
    expect(keyring.items.has('identity')).toBe(false);
  });

  it('a locked or missing keyring is unavailable; Windows never uses it', async () => {
    expect(
      await createSecretServiceKeyStore({
        platform: 'linux',
        native: fakeKeyring({ probe: false }),
      }).available(),
    ).toBe(false);
    const windows = createSecretServiceKeyStore({ platform: 'win32', native: fakeKeyring() });
    expect(await windows.available()).toBe(false);
    expect(await reason(windows.protect('identity', SECRET))).toBe('unavailable');
  });

  it('seal/open: AES-256-GCM, tampering fails', () => {
    const key = Buffer.alloc(32, 9);
    const sealed = sealWithKey(key, 'identity', SECRET);
    expect(openWithKey(key, 'identity', sealed)).toEqual(SECRET);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => openWithKey(key, 'identity', tampered)).toThrow(KeyStoreError);
    expect(() => openWithKey(Buffer.alloc(32, 8), 'identity', sealed)).toThrow(KeyStoreError);
  });

  it('a keyring call that never returns ends at the deadline (timeout), the worker is replaced', async () => {
    const worker = createSecretServiceWorker({
      timeoutMs: 150,
      // Answers nothing: stands for a keyring prompt nobody confirms.
      source: "require('node:worker_threads').parentPort.on('message', () => {});",
    });
    try {
      expect(await reason(worker.lookup('identity'))).toBe('timeout');
      expect(await reason(worker.probe())).toBe('timeout');
    } finally {
      worker.close();
    }
  });

  it('a worker blocked in a native call: no second one until its thread ended (follow-up WP-109)', async () => {
    const worker = createSecretServiceWorker({
      timeoutMs: 200,
      // `spawnSync` blocks the thread natively – like libsecret waiting for a password prompt;
      // `terminate()` cannot interrupt it.
      source: [
        "const { parentPort } = require('node:worker_threads');",
        "const { spawnSync } = require('node:child_process');",
        'parentPort.on("message", (m) => {',
        "  if (m.purpose === 'auth:slow') spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);",
        "  parentPort.postMessage({ id: m.id, ok: true, value: 'v' });",
        '});',
      ].join('\n'),
    });
    try {
      expect(await reason(worker.lookup('auth:slow'))).toBe('timeout');
      // At once, without a new worker waiting for the same prompt.
      const started = Date.now();
      expect(await reason(worker.lookup('auth:fast'))).toBe('timeout');
      expect(Date.now() - started).toBeLessThan(150);
      // Once the blocked thread ended, a new worker answers.
      await vi.waitFor(
        async () => {
          expect(await worker.lookup('auth:fast')).toBe('v');
        },
        { timeout: 15_000, interval: 100 },
      );
    } finally {
      worker.close();
    }
  });
});

describe('selection per platform (§B.14)', () => {
  const fake = (scheme: KeyStore['scheme'], available: boolean): KeyStore => {
    const memory = createMemoryKeyStore({ available });
    return {
      ...(scheme === undefined ? {} : { scheme }),
      available: () => memory.available(),
      protect: (purpose, plaintext) => memory.protect(purpose, plaintext),
      unprotect: (purpose, ciphertext) => memory.unprotect(purpose, ciphertext),
    };
  };

  it('order: keyring, systemd-creds, the file only by opt-in; the scheme of existing files first', () => {
    expect(linuxSchemeOrder('auto', null)).toEqual(['secret_service', 'systemd_creds']);
    expect(linuxSchemeOrder('file', null)).toEqual(['secret_service', 'systemd_creds', 'file']);
    expect(linuxSchemeOrder('auto', 'systemd_creds')).toEqual(['systemd_creds', 'secret_service']);
    // A key file that is `file` already counts as the opt-in.
    expect(linuxSchemeOrder('auto', 'file')).toEqual(['file', 'secret_service', 'systemd_creds']);
    // A Windows key file never selects DPAPI on Linux.
    expect(linuxSchemeOrder('auto', 'dpapi')).toEqual(['secret_service', 'systemd_creds']);
  });

  it('Linux: the first usable store wins and names its scheme', async () => {
    const store = createPlatformKeyStore({
      home: '/home/demo/.local/share/parallax',
      mode: 'auto',
      platform: 'linux',
      storedScheme: () => Promise.resolve(null),
      stores: {
        secret_service: () => fake('secret_service', false),
        systemd_creds: () => fake('systemd_creds', true),
      },
    });
    expect(store.scheme).toBeUndefined();
    expect(await store.available()).toBe(true);
    expect(store.scheme).toBe('systemd_creds');
    expect(await store.unprotect('identity', await store.protect('identity', SECRET))).toEqual(SECRET);
  });

  it('Linux without a usable store: unavailable (no silent file); the file only with the opt-in', async () => {
    const stores = {
      secret_service: () => fake('secret_service', false),
      systemd_creds: () => fake('systemd_creds', false),
      file: () => fake('file', true),
    };
    const none = createPlatformKeyStore({
      home: '/home/demo/p',
      mode: 'auto',
      platform: 'linux',
      storedScheme: () => Promise.resolve(null),
      stores,
    });
    expect(await none.available()).toBe(false);
    expect(await reason(none.protect('identity', SECRET))).toBe('unavailable');
    const optIn = createPlatformKeyStore({
      home: '/home/demo/p',
      mode: 'file',
      platform: 'linux',
      storedScheme: () => Promise.resolve(null),
      stores,
    });
    expect(await optIn.available()).toBe(true);
    expect(optIn.scheme).toBe('file');
  });

  it('Windows: DPAPI unchanged', async () => {
    const store = createPlatformKeyStore({
      home: 'D:\\work\\px',
      mode: 'auto',
      platform: 'win32',
      stores: { dpapi: () => fake(undefined, true) },
    });
    expect(store.scheme).toBe('dpapi');
    expect(await store.available()).toBe(true);
  });
});
