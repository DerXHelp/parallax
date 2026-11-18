/**
 * The Windows key store (docs/wp/WP-76.md §B.5, ADR-228): DPAPI (`CryptProtectData`, CurrentUser,
 * `CRYPTPROTECT_UI_FORBIDDEN`) with the purpose-bound entropy `parallax-keystore-v1:<purpose>`,
 * called directly in this process through Node's built-in `node:ffi` (crypt32.dll, kernel32.dll).
 *
 * Why not PowerShell (the first version): a Node process that starts PowerShell to call DPAPI looks
 * exactly like a password stealer to behaviour-based security software – the server was stopped and
 * its script removed. Here nothing is started: no script, no child process, no command line.
 *
 * - Without `node:ffi` (older Node, `--no-experimental-ffi`, the permission model) or outside
 *   Windows the store is unavailable – never a clear-text fallback.
 * - Plaintext and entropy are passed as buffers; the native result is copied, the native memory
 *   zeroed and freed (`LocalFree`). Errors become `KeyStoreError` without any data.
 * - `node:ffi` is loaded by lib/ffi.ts (one place, ADR-229; its ExperimentalWarning is swallowed).
 * - The calls are synchronous and take about a millisecond (rare: start, pairing).
 */
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { loadFfi, openLibrary, type FfiFunction } from '../lib/ffi';
import { logger as rootLogger } from '../lib/logger';
import { KeyStoreError, type KeyPurpose, type KeyStore } from './ports';

/** Purposes the store accepts (`KeyPurpose`, host ids as `hostIdSchema`). */
export const KEY_PURPOSE_PATTERN =
  /^(?:identity|coupling:[a-z0-9][a-z0-9-]{0,31}|auth:[a-z0-9][a-z0-9-]{0,31})$/u;
/** Largest plaintext (a PKCS#8 ML-DSA-87 key is ~54 bytes in seed form, ~4.9 KB expanded). */
export const KEY_STORE_MAX_PLAINTEXT = 64 * 1024;
/** Largest ciphertext accepted or returned (DPAPI adds a few hundred bytes). */
const MAX_CIPHERTEXT = 256 * 1024;
/** A failed probe is repeated at most this often (a working store is cached for the process). */
const PROBE_RETRY_MS = 60_000;
export const KEY_STORE_ENTROPY_PREFIX = 'parallax-keystore-v1:';

/** The two DPAPI calls (seam for tests): null = the call failed. Never throws. */
export interface DpapiNative {
  protect(data: Buffer, entropy: Buffer): Buffer | null;
  unprotect(data: Buffer, entropy: Buffer): Buffer | null;
}

const UI_FORBIDDEN = 0x1;
/** `DATA_BLOB` on x64: DWORD cbData, 4 bytes padding, BYTE* pbData. */
const BLOB_BYTES = 16;
const DPAPI_SIGNATURE = {
  return: 'int32',
  arguments: ['buffer', 'pointer', 'buffer', 'pointer', 'pointer', 'uint32', 'buffer'],
};

/**
 * Binds crypt32/kernel32 through `node:ffi`; null when that is not possible here (no Windows x64,
 * no `node:ffi`, a library or symbol missing). The libraries stay open for the process.
 */
export function loadDpapiNative(platform: NodeJS.Platform = process.platform): DpapiNative | null {
  if (platform !== 'win32' || process.arch !== 'x64') return null;
  const ffi = loadFfi();
  if (ffi === null) return null;
  const crypt = openLibrary('crypt32.dll', {
    CryptProtectData: DPAPI_SIGNATURE,
    CryptUnprotectData: DPAPI_SIGNATURE,
  });
  const kernel = openLibrary('kernel32.dll', { LocalFree: { return: 'pointer', arguments: ['pointer'] } });
  if (crypt === null || kernel === null) return null;
  const protectData = crypt.CryptProtectData;
  const unprotectData = crypt.CryptUnprotectData;
  const free = kernel.LocalFree;

  const blob = (data: Buffer): Buffer => {
    const out = Buffer.alloc(BLOB_BYTES);
    out.writeUInt32LE(data.length, 0);
    out.writeBigUInt64LE(data.length === 0 ? 0n : ffi.getRawPointer(data), 8);
    return out;
  };

  const call = (fn: FfiFunction, data: Buffer, entropy: Buffer): Buffer | null => {
    const result = Buffer.alloc(BLOB_BYTES);
    let ok: unknown;
    try {
      ok = fn(blob(data), 0n, blob(entropy), 0n, 0n, UI_FORBIDDEN, result);
    } catch {
      return null;
    }
    const length = result.readUInt32LE(0);
    const pointer = result.readBigUInt64LE(8);
    if (pointer === 0n) return null;
    try {
      if (ok === 0 || typeof ok !== 'number' || length === 0 || length > MAX_CIPHERTEXT) return null;
      return ffi.toBuffer(pointer, length);
    } catch {
      return null;
    } finally {
      // The native copy (plaintext on unprotect) is zeroed before it goes back to the heap.
      try {
        if (length > 0 && length <= MAX_CIPHERTEXT) ffi.exportBuffer(Buffer.alloc(length), pointer, length);
      } finally {
        free(pointer);
      }
    }
  };

  return {
    protect: (data, entropy) => call(protectData, data, entropy),
    unprotect: (data, entropy) => call(unprotectData, data, entropy),
  };
}

export interface DpapiKeyStoreOptions {
  platform?: NodeJS.Platform;
  /** The native calls (tests); default `loadDpapiNative(platform)` on first use. */
  native?: DpapiNative | null;
  logger?: Logger;
}

function checkPurpose(purpose: string): void {
  if (!KEY_PURPOSE_PATTERN.test(purpose)) throw new KeyStoreError('failed', 'invalid key purpose');
}

function entropyFor(purpose: string): Buffer {
  return Buffer.from(KEY_STORE_ENTROPY_PREFIX + purpose, 'utf8');
}

/** DPAPI key store (Windows with `node:ffi`; elsewhere `available()` is false and every call fails). */
export function createDpapiKeyStore(options: DpapiKeyStoreOptions = {}): KeyStore {
  const platform = options.platform ?? process.platform;
  const log = (options.logger ?? rootLogger).child({ module: 'keyStore' });
  // `native: null` (tests) means "no DPAPI here"; only an absent option loads node:ffi.
  let native: DpapiNative | null = options.native ?? null;
  let loaded = options.native !== undefined;
  let probed: boolean | null = null;
  let probedAt = 0;

  const getNative = (): DpapiNative | null => {
    if (platform !== 'win32') return null;
    if (!loaded) {
      native = loadDpapiNative(platform);
      loaded = true;
    }
    return native;
  };

  const run = (op: 'protect' | 'unprotect', purpose: string, data: Buffer): Buffer => {
    const api = getNative();
    if (api === null) throw new KeyStoreError('unavailable', 'DPAPI is not available here');
    const entropy = entropyFor(purpose);
    try {
      const out = api[op](data, entropy);
      if (out === null) throw new KeyStoreError('failed');
      return out;
    } finally {
      entropy.fill(0);
    }
  };

  return {
    available() {
      if (probed === true) return Promise.resolve(true);
      if (probed === false && Date.now() - probedAt < PROBE_RETRY_MS) return Promise.resolve(false);
      const sample = randomBytes(16);
      let ok = false;
      try {
        const sealed = run('protect', 'identity', sample);
        const back = run('unprotect', 'identity', sealed);
        ok = back.equals(sample);
        back.fill(0);
      } catch (error) {
        log.warn(
          { reason: error instanceof KeyStoreError ? error.reason : 'failed' },
          'DPAPI key store not available',
        );
      } finally {
        sample.fill(0);
      }
      probed = ok;
      probedAt = Date.now();
      return Promise.resolve(ok);
    },
    protect(purpose: KeyPurpose, plaintext: Buffer) {
      try {
        checkPurpose(purpose);
        if (plaintext.length === 0 || plaintext.length > KEY_STORE_MAX_PLAINTEXT) {
          throw new KeyStoreError('failed', 'invalid plaintext size');
        }
        return Promise.resolve(run('protect', purpose, plaintext));
      } catch (error) {
        return Promise.reject(error instanceof KeyStoreError ? error : new KeyStoreError('failed'));
      }
    },
    unprotect(purpose: KeyPurpose, ciphertext: Buffer) {
      try {
        checkPurpose(purpose);
        if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT) {
          throw new KeyStoreError('failed', 'invalid ciphertext size');
        }
        return Promise.resolve(run('unprotect', purpose, ciphertext));
      } catch (error) {
        return Promise.reject(error instanceof KeyStoreError ? error : new KeyStoreError('failed'));
      }
    },
  };
}
