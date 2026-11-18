/**
 * Port: keys, certificates and the Windows key store for "Several computers" (WP-76, normative:
 * docs/wp/WP-76.md §B.3–B.5). Used by remote access (WP-78, sharing computer) and the host list
 * (WP-79, controlling computer); implemented in `src/server/secure/**` (WP-78). Frozen like src/shared.
 *
 * Rules: only Node `crypto`/`tls`; ML-DSA-87 keys, SHA-384 pins; private keys only as `KeyObject`
 * in memory and DPAPI-protected on disk; never in logs, HostState, errors or the browser.
 */
import type { KeyObject } from 'node:crypto';

/**
 * `identity` (sharing computer's key) and `coupling:<hostId>` (controlling computer, one key per
 * computer) – key files; `auth:peer` / `auth:<hostId>` – the coupling secret kAuth (§B.9).
 */
export type KeyPurpose = 'identity' | `coupling:${string}` | `auth:${string}`;

/** The purposes of key files (`IdentityStore`); kAuth lives in peer.json / hosts.json. */
export type KeyFilePurpose = 'identity' | `coupling:${string}`;

/** Why the key store failed (→ REMOTE_KEYSTORE_UNAVAILABLE). */
export type KeyStoreFailure = 'unavailable' | 'failed' | 'timeout';

/** Thrown by `KeyStore`; message without secrets. */
export class KeyStoreError extends Error {
  readonly reason: KeyStoreFailure;

  constructor(reason: KeyStoreFailure, message?: string) {
    super(message ?? `key store ${reason}`);
    this.name = 'KeyStoreError';
    this.reason = reason;
  }
}

/**
 * Protects secrets for the current Windows user (DPAPI CurrentUser with purpose-bound entropy,
 * §B.5). Data travels only over stdin/stdout of the helper process, never in arguments or env.
 * Tests use an in-memory implementation – never DPAPI for files that outlive a test.
 */
export interface KeyStore {
  /** Is the store usable here (probe once, cached)? Never throws. */
  available(): Promise<boolean>;
  /** Throws KeyStoreError. */
  protect(purpose: KeyPurpose, plaintext: Buffer): Promise<Buffer>;
  /** Throws KeyStoreError (also for a tampered or foreign ciphertext). */
  unprotect(purpose: KeyPurpose, ciphertext: Buffer): Promise<Buffer>;
}

/** A loaded own key with its self-signed certificate (§B.4). */
export interface Identity {
  readonly purpose: KeyFilePurpose;
  readonly privateKey: KeyObject;
  /** X.509 v3 DER, self-signed, `CN=parallax`, no extensions. */
  readonly certificateDer: Buffer;
  /** The same certificate as PEM (TLS options). */
  readonly certificatePem: string;
  /** SHA-384 over the SPKI DER of the public key, lower-case hex (96 chars). */
  readonly pin: string;
}

/**
 * Key files under `<home>/keys/<purpose>.json` (`:` written as `-`; `keyFileSchema`, written
 * atomically, folder user-private). Loading checks key type, that the certificate's SPKI is the
 * key's public key and that the certificate verifies with it; otherwise the file is quarantined
 * and treated as missing. Every method may throw KeyStoreError.
 */
export interface IdentityStore {
  /** The key of `purpose`, decrypted once per process start and then cached; null if none. */
  load(purpose: KeyFilePurpose): Promise<Identity | null>;
  /**
   * A new ML-DSA-87 key and its certificate (created once, stored next to the key – the controlling
   * computer pins the whole certificate, §B.4), protected; replaces an existing key of `purpose`.
   */
  create(purpose: KeyFilePurpose): Promise<Identity>;
  /** Deletes the key file and the cached key; missing → no-op. */
  remove(purpose: KeyFilePurpose): Promise<void>;
}
