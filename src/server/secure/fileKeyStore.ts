/**
 * Key store "file" (docs/wp/WP-76.md §B.14, decision E1 for Ubuntu 24.04 without a desktop): an
 * explicit opt-in (`--key-store=file`) – the exception to "never a clear-text store" (§B.5). The
 * "protected" value is the secret itself behind a short marker; the protection is the file system
 * like for SSH keys: key files 0600 in `<home>/keys` (0700), checked for owner and rights before
 * every read (identityStore.ts with privateFiles.ts – a wider file is quarantined and the store
 * reports REMOTE_KEYSTORE_UNAVAILABLE).
 *
 * Attacker 3 (theft of files) is NOT covered: a copy of the data folder or of a backup holds the
 * keys. The warnings in "Share", in the preflight and on the command line say so.
 */
import { KEY_PURPOSE_PATTERN, KEY_STORE_MAX_PLAINTEXT } from './keyStore';
import { KeyStoreError, type KeyPurpose, type KeyStore } from './ports';

const MAGIC = Buffer.from('pxf1', 'ascii');

export interface FileKeyStoreOptions {
  /** Only on Linux (default `process.platform`). */
  platform?: NodeJS.Platform;
}

function checkPurpose(purpose: string): void {
  if (!KEY_PURPOSE_PATTERN.test(purpose)) throw new KeyStoreError('failed', 'invalid key purpose');
}

/** The opt-in file store (Linux only; elsewhere `available()` is false and every call fails). */
export function createFileKeyStore(options: FileKeyStoreOptions = {}): KeyStore {
  const usable = (options.platform ?? process.platform) === 'linux';
  const run = (purpose: KeyPurpose, data: Buffer, op: 'protect' | 'unprotect'): Buffer => {
    if (!usable) throw new KeyStoreError('unavailable', 'the file key store exists only on Linux');
    checkPurpose(purpose);
    if (op === 'protect') {
      if (data.length === 0 || data.length > KEY_STORE_MAX_PLAINTEXT) {
        throw new KeyStoreError('failed', 'invalid plaintext size');
      }
      return Buffer.concat([MAGIC, data]);
    }
    if (data.length <= MAGIC.length || !data.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new KeyStoreError('failed');
    }
    return Buffer.from(data.subarray(MAGIC.length));
  };
  const call = (purpose: KeyPurpose, data: Buffer, op: 'protect' | 'unprotect'): Promise<Buffer> => {
    try {
      return Promise.resolve(run(purpose, data, op));
    } catch (error) {
      return Promise.reject(error instanceof KeyStoreError ? error : new KeyStoreError('failed'));
    }
  };
  return {
    scheme: 'file',
    available: () => Promise.resolve(usable),
    protect: (purpose, plaintext) => call(purpose, plaintext, 'protect'),
    unprotect: (purpose, ciphertext) => call(purpose, ciphertext, 'unprotect'),
  };
}
