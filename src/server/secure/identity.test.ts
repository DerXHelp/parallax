import { X509Certificate, createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_NOT_AFTER,
  ML_DSA_87_OID,
  buildSelfSignedCertificate,
  objectIdentifier,
  tlv,
  unsignedInteger,
} from './der';
import { IdentityError, generateIdentity, makeIdentity } from './identity';
import {
  certificatePem,
  pinOfCertificate,
  pinOfPublicKey,
  pinsEqual,
  spkiOfCertificate,
  tryPinOfCertificate,
} from './pins';
import { buildTestCertificate } from './testKit';

describe('DER building blocks', () => {
  it('encodes OIDs, integers and lengths in minimal DER', () => {
    expect(objectIdentifier('1.2.840.113549').toString('hex')).toBe('06062a864886f70d');
    expect(objectIdentifier(ML_DSA_87_OID).toString('hex')).toBe('0609608648016503040313');
    expect(unsignedInteger(Uint8Array.of(0, 0, 5)).toString('hex')).toBe('020105');
    expect(unsignedInteger(Uint8Array.of(0x80)).toString('hex')).toBe('02020080');
    expect(unsignedInteger(Uint8Array.of(0, 0x7f)).toString('hex')).toBe('02017f');
    expect(unsignedInteger(Uint8Array.of(0)).toString('hex')).toBe('020100');
    expect(tlv(0x04, Buffer.alloc(200)).subarray(0, 3).toString('hex')).toBe('0481c8');
    expect(tlv(0x04, Buffer.alloc(300)).subarray(0, 4).toString('hex')).toBe('0482012c');
    expect(() => objectIdentifier('3.1')).toThrow(RangeError);
    expect(() => objectIdentifier('1.x')).toThrow(RangeError);
  });
});

describe('self-signed ML-DSA-87 certificate (§B.4)', () => {
  const identity = generateIdentity('identity');
  const certificate = new X509Certificate(identity.certificateDer);

  it('is a v3 certificate that X509Certificate reads and that verifies with its own key', () => {
    expect(certificate.publicKey.asymmetricKeyType).toBe('ml-dsa-87');
    expect(certificate.verify(createPublicKey(identity.privateKey))).toBe(true);
    expect(certificate.subject).toBe('CN=parallax');
    expect(certificate.issuer).toBe('CN=parallax');
    expect(certificate.validFromDate.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    expect(certificate.validToDate.toISOString()).toBe('9999-12-31T23:59:59.000Z');
    expect(CERTIFICATE_NOT_AFTER).toBe('99991231235959Z');
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toBeUndefined();
    // 16 random bytes, positive (at most one sign byte → 32 or 34 hex digits; X509 prints without it).
    expect(certificate.serialNumber).toMatch(/^[0-9A-F]{1,32}$/u);
    expect(identity.certificatePem).toBe(certificatePem(identity.certificateDer));
  });

  it('has a new serial and key every time', () => {
    const other = generateIdentity('identity');
    expect(new X509Certificate(other.certificateDer).serialNumber).not.toBe(certificate.serialNumber);
    expect(other.pin).not.toBe(identity.pin);
  });

  it('refuses keys of another type', () => {
    const ed = generateKeyPairSync('ed25519');
    expect(() => buildSelfSignedCertificate(ed.privateKey, ed.publicKey)).toThrow(TypeError);
  });
});

describe('pins (§B.3)', () => {
  const identity = generateIdentity('identity');

  it('is SHA-384 over the SPKI DER of the certificate key, lower-case hex', () => {
    const spki = createPublicKey(identity.privateKey).export({ type: 'spki', format: 'der' });
    const expected = createHash('sha384').update(spki).digest('hex');
    expect(identity.pin).toBe(expected);
    expect(pinOfCertificate(identity.certificateDer)).toBe(expected);
    expect(pinOfPublicKey(createPublicKey(identity.privateKey))).toBe(expected);
    expect(spkiOfCertificate(identity.certificateDer).equals(spki)).toBe(true);
    expect(identity.pin).toMatch(/^[0-9a-f]{96}$/u);
  });

  it('compares in constant time and is false for anything malformed', () => {
    const other = generateIdentity('identity');
    expect(pinsEqual(identity.pin, identity.pin)).toBe(true);
    expect(pinsEqual(identity.pin, other.pin)).toBe(false);
    expect(pinsEqual(identity.pin, identity.pin.toUpperCase())).toBe(false);
    expect(pinsEqual(identity.pin, identity.pin.slice(2))).toBe(false);
    expect(pinsEqual('', '')).toBe(false);
  });

  it('tryPinOfCertificate never throws', () => {
    expect(tryPinOfCertificate(Buffer.from('not a certificate'))).toBeNull();
    expect(tryPinOfCertificate(undefined)).toBeNull();
    expect(tryPinOfCertificate('text')).toBeNull();
    expect(tryPinOfCertificate(identity.certificateDer)).toBe(identity.pin);
  });
});

describe('makeIdentity – the check after loading (§B.4)', () => {
  const identity = generateIdentity('identity');
  const other = generateIdentity('identity');

  it('accepts its own key and certificate', () => {
    const again = makeIdentity('identity', identity.privateKey, identity.certificateDer);
    expect(again.pin).toBe(identity.pin);
    expect(Object.isFrozen(again)).toBe(true);
  });

  it.each([
    [
      'a foreign certificate',
      () => makeIdentity('identity', identity.privateKey, other.certificateDer),
      'key_mismatch',
    ],
    ['garbage', () => makeIdentity('identity', identity.privateKey, Buffer.from('nope')), 'certificate'],
    [
      'an Ed25519 key',
      () => makeIdentity('identity', generateKeyPairSync('ed25519').privateKey, identity.certificateDer),
      'key_type',
    ],
    [
      'an ML-DSA-65 certificate',
      () => {
        const keys = generateKeyPairSync('ml-dsa-65');
        return makeIdentity(
          'identity',
          identity.privateKey,
          buildTestCertificate(keys.privateKey, keys.publicKey, 'ml-dsa-65'),
        );
      },
      'key_type',
    ],
    [
      'a broken signature',
      () => {
        const der = Buffer.from(identity.certificateDer);
        der[der.length - 10] = (der[der.length - 10] ?? 0) ^ 0x01;
        return makeIdentity('identity', identity.privateKey, der);
      },
      'signature',
    ],
    [
      'another name',
      () => {
        const keys = generateKeyPairSync('ml-dsa-87');
        return makeIdentity(
          'identity',
          keys.privateKey,
          buildTestCertificate(keys.privateKey, keys.publicKey, 'ml-dsa-87', 'other'),
        );
      },
      'name',
    ],
  ])('refuses %s', (_label, run, problem) => {
    let caught: unknown = null;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityError);
    expect((caught as IdentityError).problem).toBe(problem);
  });
});
