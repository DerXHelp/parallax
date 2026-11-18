/**
 * The TLS profile of remote access (docs/wp/WP-76.md §B.3, ADR-206) – the ONE place of these values,
 * shared by the listener of a sharing computer (`remote/`) and the clients of a controlling computer
 * (`PinnedAgent`, `pairWithHost`). Every parameter has exactly one allowed value (no fallback):
 * TLS 1.3, TLS_AES_256_GCM_SHA384, SecP384r1MLKEM1024, ML-DSA-87, no resumption.
 */
import { constants } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import type { Identity } from './ports';

export const TLS_VERSION = 'TLSv1.3';
export const TLS_CIPHER = 'TLS_AES_256_GCM_SHA384';
/** Hybrid key exchange (ML-KEM-1024 + P-384). */
export const TLS_GROUP = 'SecP384r1MLKEM1024';
/** OpenSSL name of the only signature scheme (handshake, CertificateRequest, client certificate). */
export const TLS_SIGALG = 'mldsa87';
/** Node name of the only key type. */
export const KEY_ALGORITHM = 'ml-dsa-87';

/** The context options both sides share (§B.3). `SSL_OP_NO_TICKET`: no session tickets. */
export const TLS_PROFILE = {
  minVersion: TLS_VERSION,
  maxVersion: TLS_VERSION,
  ciphers: TLS_CIPHER,
  ecdhCurve: TLS_GROUP,
  sigalgs: TLS_SIGALG,
  secureOptions: constants.SSL_OP_NO_TICKET,
} as const;

export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** RFC 5705 §4: labels outside the IANA registry start with `EXPERIMENTAL`; 48 bytes each (§B.3). */
export const EXPORTER_LABELS = {
  pair: 'EXPERIMENTAL-parallax-pair-v1',
  auth: 'EXPERIMENTAL-parallax-auth-v1',
  conn: 'EXPERIMENTAL-parallax-conn-v1',
} as const;
export const EXPORTER_BYTES = 48;
/** HMAC-SHA-384 / HKDF-SHA-384 output and the coupling secret kAuth. */
export const SECRET_BYTES = 48;
export const HASH = 'sha384';

/** TLS 1.3 treats an absent and an empty exporter context alike (RFC 8446 §7.5); Node's types want one. */
const NO_CONTEXT = Buffer.alloc(0);

/** `exportKeyingMaterial(48, label)` of this connection (same value on both ends). */
export function exportKeyingMaterial(socket: TLSSocket, label: keyof typeof EXPORTER_LABELS): Buffer {
  return Buffer.from(socket.exportKeyingMaterial(EXPORTER_BYTES, EXPORTER_LABELS[label], NO_CONTEXT));
}

/**
 * PEM of the private key for a TLS context (OpenSSL reads keys only as PEM here). The returned buffer
 * should be zeroed after the context was built; the intermediate string cannot be (V8 strings).
 */
export function privateKeyPem(identity: Identity): Buffer {
  return Buffer.from(identity.privateKey.export({ type: 'pkcs8', format: 'pem' }));
}

/** Why an established connection does not match the profile (never thrown – see `profileViolation`). */
export type ProfileViolation = 'reused' | 'protocol' | 'cipher' | 'group' | 'certificate' | 'check_failed';

/**
 * Checks an established connection against §B.3 (both sides; the group only where Node reports it,
 * i.e. on the client). Returns null when it matches. Never throws (fail closed: any exception is a
 * violation).
 */
export function profileViolation(socket: TLSSocket, side: 'client' | 'server'): ProfileViolation | null {
  try {
    if (socket.isSessionReused()) return 'reused';
    if (socket.getProtocol() !== TLS_VERSION) return 'protocol';
    if (socket.getCipher().name !== TLS_CIPHER) return 'cipher';
    if (side === 'client') {
      const info = socket.getEphemeralKeyInfo();
      if (info === null || !('name' in info) || info.name !== TLS_GROUP) return 'group';
    }
    const peer = socket.getPeerX509Certificate();
    if (peer?.publicKey.asymmetricKeyType !== KEY_ALGORITHM) return 'certificate';
    return null;
  } catch {
    return 'check_failed';
  }
}
