/**
 * Pairing cryptography (docs/wp/WP-76.md §B.7, ADR-207) – used by both ends: the sharing computer's
 * pairing route (`remote/`) and `pairWithHost` of the controlling computer. Only HKDF-SHA-384 and
 * HMAC-SHA-384 (RFC 5869, RFC 2104) over values taken from the TLS connection itself.
 *
 *   k     = HKDF-SHA-384(ikm = code (16 bytes), salt = 'parallax-pair-v1', info = 'pair-mac', L = 48)
 *   T     = lp('parallax-pair-v1') ‖ lp(ekm) ‖ lp(spkiB) ‖ lp(spkiA),   lp(x) = uint32be(len(x)) ‖ x
 *   macA  = HMAC-SHA-384(k, lp('initiator') ‖ T)      (controlling computer, proves first)
 *   macB  = HMAC-SHA-384(k, lp('responder') ‖ T)      (sharing computer)
 *   kMix  = HKDF-SHA-384(ikm = code (16 bytes), salt = 'parallax-pair-v1', info = 'auth-mix', L = 48)
 *   kAuth = HKDF-SHA-384(ikm = ekm_auth ‖ kMix, salt = 'parallax-auth-v1', info = SHA-384(T), L = 48)
 *
 * kMix (security review WP-82, §B.7 step 7.2): kAuth depends on the code as well, not only on the
 * TLS key exchange – whoever could read ekm_auth (a broken key exchange, recorded traffic) still
 * needs the code, which never travels. Own `info`, so k (the MAC key) is never used twice.
 *
 * Deviation (docs/wp/WP-78a.md): `info = SHA-384(T)` instead of `T` – OpenSSL limits the HKDF info to
 * 1024 bytes, T is ~5.3 KB (two ML-DSA-87 SPKIs). The hash binds kAuth to the same transcript.
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { PAIRING_CODE_BYTES } from '@shared/pairing';
import { bytesEqual, connectionSpkis } from './pins';
import { HASH, SECRET_BYTES, exportKeyingMaterial } from './tlsProfile';

export const PAIR_LABEL = 'parallax-pair-v1';
export const AUTH_SALT = 'parallax-auth-v1';
const PAIR_MAC_INFO = 'pair-mac';
const AUTH_MIX_INFO = 'auth-mix';
export type PairingRole = 'initiator' | 'responder';

/** `uint32be(len(x)) ‖ x` – one buffer, no intermediate copy of `value`. */
export function lp(value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const out = Buffer.alloc(4 + bytes.length);
  out.writeUInt32BE(bytes.length, 0);
  out.set(bytes, 4);
  return out;
}

/** T of §B.7; the length-prefixed parts (they hold the exporter value) are zeroed after joining. */
export function pairingTranscript(ekm: Uint8Array, spkiB: Uint8Array, spkiA: Uint8Array): Buffer {
  const parts = [lp(PAIR_LABEL), lp(ekm), lp(spkiB), lp(spkiA)];
  try {
    return Buffer.concat(parts);
  } finally {
    for (const part of parts) part.fill(0);
  }
}

/** k from the 16 code bytes. */
export function pairingKey(code: Uint8Array): Buffer {
  if (code.length !== PAIRING_CODE_BYTES) throw new RangeError('pairing code must be 16 bytes');
  return Buffer.from(hkdfSync(HASH, code, PAIR_LABEL, PAIR_MAC_INFO, SECRET_BYTES));
}

export function pairingMac(k: Uint8Array, role: PairingRole, transcript: Uint8Array): Buffer {
  return createHmac(HASH, k).update(lp(role)).update(transcript).digest();
}

/** kAuth from the auth exporter, the transcript and the 16 code bytes; intermediate keys are zeroed. */
export function deriveAuthKey(ekmAuth: Uint8Array, transcript: Uint8Array, code: Uint8Array): Buffer {
  if (code.length !== PAIRING_CODE_BYTES) throw new RangeError('pairing code must be 16 bytes');
  const info = createHash(HASH).update(transcript).digest();
  const mix = Buffer.from(hkdfSync(HASH, code, PAIR_LABEL, AUTH_MIX_INFO, SECRET_BYTES));
  const ikm = Buffer.concat([ekmAuth, mix]);
  try {
    return Buffer.from(hkdfSync(HASH, ikm, AUTH_SALT, info, SECRET_BYTES));
  } finally {
    mix.fill(0);
    ikm.fill(0);
  }
}

/** Constant-time MAC comparison (false for another length; never throws). */
export function macEquals(expected: Uint8Array, given: Uint8Array): boolean {
  return expected.length === SECRET_BYTES && bytesEqual(expected, given);
}

/** 48 bytes as base64url without padding (64 chars, `remotePairRequestSchema.macA`). */
export function encodeMac(mac: Uint8Array): string {
  return Buffer.from(mac).toString('base64url');
}

/** Exactly 48 bytes from base64url without padding, or null. */
export function decodeMac(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{64}$/u.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === SECRET_BYTES ? bytes : null;
}

/** Everything both ends take from the pairing socket (§B.7 step 2). Throws when a certificate is missing. */
export interface PairingMaterial {
  transcript: Buffer;
  ekmAuth: Buffer;
  spkiA: Buffer;
  spkiB: Buffer;
}

export function pairingMaterial(socket: TLSSocket, side: 'client' | 'server'): PairingMaterial {
  const { spkiA, spkiB } = connectionSpkis(socket, side);
  const ekm = exportKeyingMaterial(socket, 'pair');
  const ekmAuth = exportKeyingMaterial(socket, 'auth');
  const transcript = pairingTranscript(ekm, spkiB, spkiA);
  ekm.fill(0);
  return { transcript, ekmAuth, spkiA, spkiB };
}

/** Overwrites the secret parts of the material (§B.7 step 9). */
export function wipePairingMaterial(material: PairingMaterial): void {
  material.transcript.fill(0);
  material.ekmAuth.fill(0);
}
