import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeMac,
  deriveAuthKey,
  encodeMac,
  lp,
  macEquals,
  pairingKey,
  pairingMac,
  pairingTranscript,
} from './pairingCrypto';

/** RFC 5869 written out with HMAC (reference for the parameters; L ≤ 48 → one block). */
function hkdfReference(ikm: Uint8Array, salt: string, info: Uint8Array | string): Buffer {
  const prk = createHmac('sha384', salt).update(ikm).digest();
  return createHmac('sha384', prk)
    .update(typeof info === 'string' ? Buffer.from(info) : info)
    .update(Buffer.from([1]))
    .digest();
}

describe('pairing cryptography (§B.7)', () => {
  const code = randomBytes(16);
  const ekm = randomBytes(48);
  const spkiA = randomBytes(2614);
  const spkiB = randomBytes(2614);

  it('lp() is uint32be(length) ‖ bytes', () => {
    expect(lp('ab').toString('hex')).toBe('000000026162');
    expect(lp(Buffer.alloc(0)).toString('hex')).toBe('00000000');
    expect(lp(Buffer.alloc(300)).subarray(0, 4).toString('hex')).toBe('0000012c');
  });

  it('builds T = lp(label) ‖ lp(ekm) ‖ lp(spkiB) ‖ lp(spkiA)', () => {
    const transcript = pairingTranscript(ekm, spkiB, spkiA);
    expect(transcript.equals(Buffer.concat([lp('parallax-pair-v1'), lp(ekm), lp(spkiB), lp(spkiA)]))).toBe(
      true,
    );
    // Binding: swapping the keys changes T.
    expect(pairingTranscript(ekm, spkiA, spkiB).equals(transcript)).toBe(false);
  });

  it('k = HKDF-SHA-384(code, salt parallax-pair-v1, info pair-mac, 48)', () => {
    expect(pairingKey(code).equals(hkdfReference(code, 'parallax-pair-v1', 'pair-mac'))).toBe(true);
    expect(pairingKey(code)).toHaveLength(48);
    expect(() => pairingKey(randomBytes(15))).toThrow(RangeError);
  });

  it('macA/macB = HMAC-SHA-384(k, lp(role) ‖ T) with distinct role labels (no reflection)', () => {
    const k = pairingKey(code);
    const transcript = pairingTranscript(ekm, spkiB, spkiA);
    const macA = pairingMac(k, 'initiator', transcript);
    const macB = pairingMac(k, 'responder', transcript);
    expect(macA.equals(createHmac('sha384', k).update(lp('initiator')).update(transcript).digest())).toBe(
      true,
    );
    expect(macA.equals(macB)).toBe(false);
    expect(macA).toHaveLength(48);
    // Another connection (other ekm) or another code gives another MAC.
    expect(pairingMac(k, 'initiator', pairingTranscript(randomBytes(48), spkiB, spkiA)).equals(macA)).toBe(
      false,
    );
    expect(pairingMac(pairingKey(randomBytes(16)), 'initiator', transcript).equals(macA)).toBe(false);
  });

  it('kAuth = HKDF-SHA-384(ekm_auth ‖ kMix, salt parallax-auth-v1, info SHA-384(T), 48) – T is longer than 1024 bytes', () => {
    const ekmAuth = randomBytes(48);
    const code = randomBytes(16);
    const transcript = pairingTranscript(ekm, spkiB, spkiA);
    expect(transcript.length).toBeGreaterThan(1024);
    const info = createHash('sha384').update(transcript).digest();
    const mix = hkdfReference(code, 'parallax-pair-v1', 'auth-mix');
    const expected = hkdfReference(Buffer.concat([ekmAuth, mix]), 'parallax-auth-v1', info);
    expect(deriveAuthKey(ekmAuth, transcript, code).equals(expected)).toBe(true);
    // The code is mixed in: another code, another kAuth; kMix is not the MAC key k.
    expect(deriveAuthKey(ekmAuth, transcript, randomBytes(16)).equals(expected)).toBe(false);
    expect(mix.equals(pairingKey(code))).toBe(false);
    expect(() => deriveAuthKey(ekmAuth, transcript, randomBytes(15))).toThrow(RangeError);
  });

  it('encodes MACs as 64 base64url chars and decodes only exactly 48 bytes', () => {
    const mac = randomBytes(48);
    const text = encodeMac(mac);
    expect(text).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(decodeMac(text)?.equals(mac)).toBe(true);
    expect(decodeMac(text.slice(1))).toBeNull();
    expect(decodeMac(`${text}A`)).toBeNull();
    expect(decodeMac(text.replace(/.$/u, '='))).toBeNull();
    expect(decodeMac(text.replace(/^./u, '+'))).toBeNull();
  });

  it('macEquals is false for other lengths and other values', () => {
    const mac = randomBytes(48);
    expect(macEquals(mac, Buffer.from(mac))).toBe(true);
    expect(macEquals(mac, mac.subarray(0, 47))).toBe(false);
    expect(macEquals(mac.subarray(0, 32), mac.subarray(0, 32))).toBe(false);
    const other = Buffer.from(mac);
    other[47] = (other[47] ?? 0) ^ 1;
    expect(macEquals(mac, other)).toBe(false);
  });
});
