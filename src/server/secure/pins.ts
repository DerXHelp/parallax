/**
 * Pins (docs/wp/WP-76.md §B.3/B.4): SHA-384 over the SPKI DER of a certificate's public key, lower-case
 * hex (96 chars). Always determined from `new X509Certificate(raw).publicKey` – never from
 * `cert.pubkey`, which Node leaves undefined for ML-DSA (Review t1). Comparisons only with
 * `timingSafeEqual` after a length check.
 */
import { X509Certificate, createHash, timingSafeEqual, type KeyObject } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { HASH } from './tlsProfile';

const PIN_PATTERN = /^[0-9a-f]{96}$/u;

/** SPKI DER of a public key. */
export function spkiOfPublicKey(key: KeyObject): Buffer {
  return key.export({ type: 'spki', format: 'der' });
}

/** SPKI DER of the key in a DER certificate. Throws for anything that is not a certificate. */
export function spkiOfCertificate(raw: Uint8Array): Buffer {
  return spkiOfPublicKey(new X509Certificate(raw).publicKey);
}

export function pinOfSpki(spki: Uint8Array): string {
  return createHash(HASH).update(spki).digest('hex');
}

/** Pin of a DER certificate. Throws for anything that is not a certificate. */
export function pinOfCertificate(raw: Uint8Array): string {
  return pinOfSpki(spkiOfCertificate(raw));
}

export function pinOfPublicKey(key: KeyObject): string {
  return pinOfSpki(spkiOfPublicKey(key));
}

/** Pin of a DER certificate, or null (never throws). */
export function tryPinOfCertificate(raw: unknown): string | null {
  try {
    return raw instanceof Uint8Array ? pinOfCertificate(raw) : null;
  } catch {
    return null;
  }
}

/** Constant-time equality of two pins (false for anything malformed; never throws). */
export function pinsEqual(a: string, b: string): boolean {
  try {
    if (!PIN_PATTERN.test(a) || !PIN_PATTERN.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** Constant-time equality of two byte strings of any length (false when the lengths differ; never throws). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  try {
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** PEM of a DER certificate (TLS options want PEM for `cert`/`ca`). */
export function certificatePem(der: Uint8Array): string {
  const base64 = Buffer.from(der).toString('base64');
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * `spkiB` (sharing computer, TLS server) and `spkiA` (controlling computer, TLS client) of an
 * established connection, taken from the socket itself – never from message fields (§B.7 step 2).
 * Throws when a certificate is missing.
 */
export function connectionSpkis(
  socket: TLSSocket,
  side: 'client' | 'server',
): { spkiA: Buffer; spkiB: Buffer } {
  const own = socket.getX509Certificate();
  const peer = socket.getPeerX509Certificate();
  if (own === undefined || peer === undefined) throw new Error('certificate missing');
  const ownSpki = spkiOfPublicKey(own.publicKey);
  const peerSpki = spkiOfPublicKey(peer.publicKey);
  return side === 'server' ? { spkiB: ownSpki, spkiA: peerSpki } : { spkiB: peerSpki, spkiA: ownSpki };
}
