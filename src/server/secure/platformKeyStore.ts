/**
 * The key store of this platform (docs/wp/WP-76.md §B.5, §B.14; decision E1, WP-101 §3) – one store
 * for both sides of "Several computers", built by the composition (`createPlatformKeyStore`):
 *
 * - Windows: DPAPI (unchanged).
 * - Linux: the first usable of Secret Service (desktop, GNOME Keyring), `systemd-creds --user`
 *   (without a desktop, systemd ≥ 256) and – only with the opt-in `--key-store=file`, or when the key
 *   files already say `file` – the 0600 file. Key files that exist name their scheme: that scheme is
 *   tried first, so installing a desktop later does not lock the old keys away (a change of scheme
 *   needs a new pairing, never a silent re-encryption – identityStore.ts refuses a key file of
 *   another scheme). Nothing usable → `available()` false (no sharing, no pairing:
 *   REMOTE_KEYSTORE_UNAVAILABLE).
 * - Other platforms: nothing.
 *
 * The choice is made on first use (probing may take a moment: the keyring may ask for its password)
 * and kept once a store answered; while none is usable it is tried again after a minute.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { keyFileSchema, type KeyStoreScheme } from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { createFileKeyStore } from './fileKeyStore';
import { KEYS_DIR } from './identityStore';
import { createDpapiKeyStore } from './keyStore';
import { KeyStoreError, type KeyStore } from './ports';
import { createSecretServiceKeyStore } from './secretServiceKeyStore';
import { createSystemdCredsKeyStore } from './systemdCredsKeyStore';

/** `config.keyStore` (config.ts `KeyStoreMode`): `file` = the opt-in for the 0600 file (Linux). */
export type PlatformKeyStoreMode = 'auto' | 'file';

const RETRY_MS = 60_000;

export interface PlatformKeyStoreOptions {
  home: string;
  mode: PlatformKeyStoreMode;
  platform?: NodeJS.Platform;
  logger?: Logger;
  /** Store factories (tests); default the real implementations. */
  stores?: Partial<Record<KeyStoreScheme, () => KeyStore>>;
  /** Scheme of the existing key files (default: read `<home>/keys/*.json`). */
  storedScheme?: () => Promise<KeyStoreScheme | null>;
  now?: () => number;
}

/** A store that may own resources (the Secret Service worker). */
export interface PlatformKeyStore extends KeyStore {
  /** The scheme in use; undefined until a store answered (Windows: `dpapi` at once). */
  readonly scheme?: KeyStoreScheme;
  /** Ends a worker (server shutdown). */
  close(): void;
}

/** The scheme of the first readable key file in `<home>/keys`, or null. Never throws. */
export async function readStoredScheme(home: string): Promise<KeyStoreScheme | null> {
  const dir = path.join(home, KEYS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const parsed = keyFileSchema.safeParse(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
      if (parsed.success) return parsed.data.scheme;
    } catch {
      // unreadable or no JSON: the identity store quarantines it later
    }
  }
  return null;
}

/** The order in which Linux tries the stores. */
export function linuxSchemeOrder(
  mode: PlatformKeyStoreMode,
  stored: KeyStoreScheme | null,
): KeyStoreScheme[] {
  const order: KeyStoreScheme[] = ['secret_service', 'systemd_creds'];
  if (mode === 'file' || stored === 'file') order.push('file');
  if (stored !== null && stored !== 'dpapi') {
    return [stored, ...order.filter((scheme) => scheme !== stored)];
  }
  return order;
}

export function createPlatformKeyStore(options: PlatformKeyStoreOptions): PlatformKeyStore {
  const platform = options.platform ?? process.platform;
  const log = (options.logger ?? rootLogger).child({ module: 'keyStore' });
  const loggerOption = options.logger === undefined ? {} : { logger: options.logger };
  if (platform === 'win32') {
    const dpapi = options.stores?.dpapi?.() ?? createDpapiKeyStore(loggerOption);
    return {
      scheme: 'dpapi',
      available: () => dpapi.available(),
      protect: (purpose, plaintext) => dpapi.protect(purpose, plaintext),
      unprotect: (purpose, ciphertext) => dpapi.unprotect(purpose, ciphertext),
      close: () => undefined,
    };
  }

  const now = options.now ?? (() => Date.now());
  const storedScheme = options.storedScheme ?? (() => readStoredScheme(options.home));
  const built = new Map<KeyStoreScheme, KeyStore>();
  let secretService: ReturnType<typeof createSecretServiceKeyStore> | null = null;
  const make = (scheme: KeyStoreScheme): KeyStore => {
    const existing = built.get(scheme);
    if (existing !== undefined) return existing;
    const factory = options.stores?.[scheme];
    let store: KeyStore;
    if (factory !== undefined) store = factory();
    else if (scheme === 'secret_service') {
      secretService = createSecretServiceKeyStore({ platform, ...loggerOption });
      store = secretService;
    } else if (scheme === 'systemd_creds') store = createSystemdCredsKeyStore({ platform, ...loggerOption });
    else if (scheme === 'file') store = createFileKeyStore({ platform });
    else store = createDpapiKeyStore({ platform, ...loggerOption });
    built.set(scheme, store);
    return store;
  };

  let chosen: KeyStore | null = null;
  let chosenScheme: KeyStoreScheme | undefined;
  let selecting: Promise<KeyStore | null> | null = null;
  let failedAt = Number.NEGATIVE_INFINITY;

  const select = (): Promise<KeyStore | null> => {
    if (chosen !== null) return Promise.resolve(chosen);
    if (now() - failedAt < RETRY_MS) return Promise.resolve(null);
    selecting ??= (async () => {
      if (platform !== 'linux') return null;
      const stored = await storedScheme().catch(() => null);
      for (const scheme of linuxSchemeOrder(options.mode, stored)) {
        const store = make(scheme);
        if (await store.available().catch(() => false)) {
          chosen = store;
          chosenScheme = scheme;
          if (scheme === 'file') {
            log.warn(
              'keys of "Several computers" are kept in a 0600 file (--key-store=file) - a copy of the data folder holds them',
            );
          } else log.info({ scheme }, 'key store selected');
          if (stored !== null && stored !== scheme) {
            log.warn({ stored, scheme }, 'key files of another scheme - pair again (renew the key)');
          }
          return store;
        }
      }
      failedAt = now();
      log.warn({ mode: options.mode }, 'no key store usable on this computer');
      return null;
    })().finally(() => {
      selecting = null;
    });
    return selecting;
  };

  const require = async (): Promise<KeyStore> => {
    const store = await select();
    if (store === null) throw new KeyStoreError('unavailable', 'no key store usable here');
    return store;
  };

  return {
    get scheme() {
      return chosenScheme;
    },
    available: async () => (await select()) !== null,
    protect: async (purpose, plaintext) => (await require()).protect(purpose, plaintext),
    unprotect: async (purpose, ciphertext) => (await require()).unprotect(purpose, ciphertext),
    close: () => {
      secretService?.close();
    },
  };
}
