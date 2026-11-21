/**
 * Key files `<home>/keys/<purpose>.json` (docs/wp/WP-76.md §B.4/B.5, `keyFileSchema`): the private key
 * as DPAPI(PKCS#8 DER), the own certificate in clear (public). Written atomically without `.bak`.
 *
 * Loading checks the schema, the purpose, the key type, that the certificate's SPKI is the key's
 * public key, that the certificate verifies with it and its name; any mismatch quarantines the file
 * (it then counts as missing). A key store failure (DPAPI unavailable, foreign or tampered
 * ciphertext) is NOT a quarantine – it throws KeyStoreError (fail closed; "Schlüssel erneuern"
 * replaces the file). Without a usable key store nothing is ever written (never a clear-text key).
 *
 * WP-107 (§B.14): the file names the scheme of its store (`scheme`); a file of another scheme is not
 * read (KeyStoreError – pair again / renew the key, never a silent re-encryption). With the opt-in
 * `file` the key lies in clear: written 0600 in a 0700 folder (strictJsonFile.ts, POSIX) and checked
 * for owner and rights before every read.
 */
import { createPrivateKey } from 'node:crypto';
import path from 'node:path';
import {
  KEY_FILE_SCHEMA_VERSION,
  keyFileSchema,
  keyPurposeSchema,
  type KeyFile,
  type KeyStoreScheme,
} from '@shared/model';
import { logger as rootLogger } from '../lib/logger';
import { IdentityError, generateIdentity, makeIdentity } from './identity';
import { checkPrivateFile, narrowPrivateDir, type PrivateFileIssue } from './privateFiles';
import {
  KeyStoreError,
  type Identity,
  type IdentityStore,
  type KeyFilePurpose,
  type KeyStore,
} from './ports';
import {
  quarantineStrictFile,
  readStrictJson,
  removeStrictFile,
  writeStrictJson,
  type StrictFileOptions,
} from './strictJsonFile';
import { KEY_ALGORITHM } from './tlsProfile';

export const KEYS_DIR = 'keys';

/** `<home>/keys/<purpose>.json` with `:` written as `-`. Throws for an invalid purpose. */
export function keyFilePath(home: string, purpose: KeyFilePurpose): string {
  if (!keyPurposeSchema.safeParse(purpose).success) throw new RangeError('invalid key purpose');
  return path.join(home, KEYS_DIR, `${purpose.replace(':', '-')}.json`);
}

export interface IdentityStoreOptions extends StrictFileOptions {
  home: string;
  keyStore: KeyStore;
  /** Default `process.platform` (the rights check of clear-text keys is POSIX only). */
  platform?: NodeJS.Platform;
  /** Rights check of a clear-text key file (tests); default `checkPrivateFile`. */
  checkFile?: (file: string) => Promise<PrivateFileIssue | null>;
}

/** The scheme a store writes into key files (`keyFileSchema.scheme`; absent = `dpapi`). */
export function schemeOf(keyStore: KeyStore): KeyStoreScheme {
  return keyStore.scheme ?? 'dpapi';
}

/** `IdentityStore` plus `save` for a key generated in memory (the controlling computer stores the coupling key only after a successful pairing, §B.7 step 8). */
export interface FileIdentityStore extends IdentityStore {
  /** Protects and writes `identity` (replaces an existing key of its purpose) and caches it. */
  save(identity: Identity): Promise<void>;
}

export function createIdentityStore(options: IdentityStoreOptions): FileIdentityStore {
  const { home, keyStore } = options;
  const platform = options.platform ?? process.platform;
  const log = (options.logger ?? rootLogger).child({ module: 'identityStore' });
  const now = options.now ?? (() => new Date());
  const cache = new Map<KeyFilePurpose, Identity>();
  const loading = new Map<KeyFilePurpose, Promise<Identity | null>>();
  /** Raised by save/remove: a load that started earlier must not cache its (older) result. */
  const epochs = new Map<KeyFilePurpose, number>();
  const epochOf = (purpose: KeyFilePurpose): number => epochs.get(purpose) ?? 0;
  const bump = (purpose: KeyFilePurpose): void => {
    epochs.set(purpose, epochOf(purpose) + 1);
  };

  const requireKeyStore = async (): Promise<void> => {
    if (!(await keyStore.available())) throw new KeyStoreError('unavailable');
  };

  /**
   * §B.14 (scheme `file`): before a clear-text key is read, the file must belong to this user and
   * give group/others nothing (its folder likewise) – otherwise it is quarantined and the store
   * counts as unavailable (fail closed).
   */
  const guardClearText = async (file: string): Promise<void> => {
    if (platform === 'win32') return;
    if (!(await keyStore.available().catch(() => false)) || schemeOf(keyStore) !== 'file') return;
    const issue = await (options.checkFile ?? checkPrivateFile)(file);
    if (issue === null) return;
    await quarantineStrictFile(file, `rights_${issue}`, options);
    throw new KeyStoreError('unavailable', 'key file readable by others');
  };

  const readIdentity = async (purpose: KeyFilePurpose): Promise<Identity | null> => {
    const file = keyFilePath(home, purpose);
    await guardClearText(file);
    const read = await readStrictJson(file, keyFileSchema, KEY_FILE_SCHEMA_VERSION, options);
    if (read.kind !== 'ok') return null;
    const record = read.value;
    if (record.purpose !== purpose) {
      await quarantineStrictFile(file, 'purpose', options);
      return null;
    }
    await requireKeyStore();
    // §B.14: a key file of another scheme is never read (a new pairing / "renew key" replaces it).
    if (record.scheme !== schemeOf(keyStore)) {
      log.warn({ purpose, stored: record.scheme, scheme: schemeOf(keyStore) }, 'key file of another scheme');
      throw new KeyStoreError('unavailable', 'key file of another scheme');
    }
    const pkcs8 = await keyStore.unprotect(purpose, Buffer.from(record.protected, 'base64'));
    try {
      const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
      return makeIdentity(purpose, privateKey, Buffer.from(record.certificate, 'base64'));
    } catch (error) {
      const reason = error instanceof IdentityError ? error.problem : 'key';
      await quarantineStrictFile(file, reason, options);
      return null;
    } finally {
      pkcs8.fill(0);
    }
  };

  const save = async (identity: Identity): Promise<void> => {
    await requireKeyStore();
    const file = keyFilePath(home, identity.purpose);
    const pkcs8 = identity.privateKey.export({ type: 'pkcs8', format: 'der' });
    let sealed: Buffer;
    try {
      sealed = await keyStore.protect(identity.purpose, pkcs8);
    } finally {
      pkcs8.fill(0);
    }
    const record: KeyFile = {
      schemaVersion: KEY_FILE_SCHEMA_VERSION,
      purpose: identity.purpose,
      algorithm: KEY_ALGORITHM,
      protected: sealed.toString('base64'),
      scheme: schemeOf(keyStore),
      certificate: identity.certificateDer.toString('base64'),
      createdAt: now().toISOString(),
    };
    // POSIX: an older, wider keys folder is narrowed first (the rights check reads it, §B.14).
    if (options.fs === undefined) await narrowPrivateDir(path.dirname(file), platform);
    await writeStrictJson(file, keyFileSchema.parse(record), options);
    bump(identity.purpose);
    cache.set(identity.purpose, identity);
    log.info({ purpose: identity.purpose, pin: identity.pin }, 'key stored');
  };

  return {
    load(purpose) {
      const cached = cache.get(purpose);
      if (cached !== undefined) return Promise.resolve(cached);
      const pending = loading.get(purpose);
      if (pending !== undefined) return pending;
      const epoch = epochOf(purpose);
      const promise = readIdentity(purpose)
        .then((identity) => {
          if (epochOf(purpose) !== epoch) return cache.get(purpose) ?? null;
          if (identity !== null) cache.set(purpose, identity);
          return identity;
        })
        .finally(() => loading.delete(purpose));
      loading.set(purpose, promise);
      return promise;
    },
    async create(purpose) {
      await requireKeyStore();
      const identity = generateIdentity(purpose);
      await save(identity);
      return identity;
    },
    save,
    async remove(purpose) {
      bump(purpose);
      cache.delete(purpose);
      await removeStrictFile(keyFilePath(home, purpose), options);
      log.info({ purpose }, 'key removed');
    },
  };
}
