/**
 * In-memory `KeyStore` for tests (also of WP-79/WP-82; docs/wp/WP-76.md §B.5: tests never use the
 * DPAPI of the test machine for files that outlive a test). No cryptography: `protect` returns a
 * random handle; `unprotect` returns the plaintext only for the same store, the same purpose and an
 * unchanged handle – like DPAPI, a foreign or tampered "ciphertext" fails. The handle never contains
 * the plaintext, so a file written with it holds no secret.
 */
import { randomBytes } from 'node:crypto';
import { KEY_PURPOSE_PATTERN } from './keyStore';
import { KeyStoreError, type KeyPurpose, type KeyStore, type KeyStoreFailure } from './ports';

const MAGIC = Buffer.from('mks1', 'ascii');
const HANDLE_BYTES = 32;

export interface MemoryKeyStore extends KeyStore {
  setAvailable(available: boolean): void;
  /** The next protect/unprotect call fails with this reason. */
  failNext(reason: KeyStoreFailure): void;
  /** Every call (purpose and operation, never data). */
  readonly calls: { op: 'protect' | 'unprotect'; purpose: KeyPurpose }[];
  /** Number of stored secrets. */
  size(): number;
}

export function createMemoryKeyStore(options: { available?: boolean } = {}): MemoryKeyStore {
  let available = options.available ?? true;
  let failure: KeyStoreFailure | null = null;
  const secrets = new Map<string, { purpose: KeyPurpose; data: Buffer }>();
  const calls: MemoryKeyStore['calls'] = [];

  const guard = (op: 'protect' | 'unprotect', purpose: KeyPurpose): void => {
    calls.push({ op, purpose });
    if (!available) throw new KeyStoreError('unavailable');
    if (failure !== null) {
      const reason = failure;
      failure = null;
      throw new KeyStoreError(reason);
    }
    if (!KEY_PURPOSE_PATTERN.test(purpose)) throw new KeyStoreError('failed', 'invalid key purpose');
  };

  return {
    calls,
    setAvailable(value) {
      available = value;
    },
    failNext(reason) {
      failure = reason;
    },
    size: () => secrets.size,
    available: () => Promise.resolve(available),
    protect(purpose, plaintext) {
      try {
        guard('protect', purpose);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new KeyStoreError('failed'));
      }
      const handle = randomBytes(HANDLE_BYTES);
      secrets.set(handle.toString('hex'), { purpose, data: Buffer.from(plaintext) });
      return Promise.resolve(Buffer.concat([MAGIC, handle]));
    },
    unprotect(purpose, ciphertext) {
      try {
        guard('unprotect', purpose);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new KeyStoreError('failed'));
      }
      const valid =
        ciphertext.length === MAGIC.length + HANDLE_BYTES &&
        ciphertext.subarray(0, MAGIC.length).equals(MAGIC);
      const entry = valid ? secrets.get(ciphertext.subarray(MAGIC.length).toString('hex')) : undefined;
      if (entry?.purpose !== purpose) return Promise.reject(new KeyStoreError('failed'));
      return Promise.resolve(Buffer.from(entry.data));
    },
  };
}
