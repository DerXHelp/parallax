/**
 * Minimal DER encoder for the one certificate Parallax builds (docs/wp/WP-76.md §B.4, Spike A): an
 * X.509 v3 certificate without extensions, self-signed with ML-DSA-87 (FIPS 204, pure mode, empty
 * context – `crypto.sign(null, …)`). No parser: reading always goes through `X509Certificate`.
 *
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }
 * TBSCertificate ::= SEQUENCE { [0] EXPLICIT version v3, serialNumber, signature, issuer, validity,
 *   subject, subjectPublicKeyInfo } (RFC 5280 §4.1)
 */
import { randomBytes, sign, type KeyObject } from 'node:crypto';

/** id-ml-dsa-87 (NIST CSOR sigAlgs; IETF LAMPS ML-DSA certificates): AlgorithmIdentifier without parameters. */
export const ML_DSA_87_OID = '2.16.840.1.101.3.4.3.19';
const COMMON_NAME_OID = '2.5.4.3';
export const CERTIFICATE_COMMON_NAME = 'parallax';
/** notBefore 2000-01-01 (UTCTime), notAfter 9999-12-31 (GeneralizedTime, RFC 5280 §4.1.2.5). */
export const CERTIFICATE_NOT_BEFORE = '000101000000Z';
export const CERTIFICATE_NOT_AFTER = '99991231235959Z';
export const SERIAL_BYTES = 16;

const TAG = {
  integer: 0x02,
  bitString: 0x03,
  oid: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31,
  explicit0: 0xa0,
} as const;

function encodeLength(length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('DER length out of range');
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One TLV. */
export function tlv(tag: number, ...content: readonly Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function sequence(...content: readonly Buffer[]): Buffer {
  return tlv(TAG.sequence, ...content);
}

export function objectIdentifier(dotted: string): Buffer {
  const arcs = dotted.split('.').map((arc) => {
    if (!/^\d+$/u.test(arc)) throw new RangeError('invalid OID');
    return Number(arc);
  });
  const [first, second, ...rest] = arcs;
  if (first === undefined || second === undefined || first > 2 || (first < 2 && second > 39)) {
    throw new RangeError('invalid OID');
  }
  const bytes: number[] = [];
  for (const arc of [first * 40 + second, ...rest]) {
    const group: number[] = [arc & 0x7f];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      group.unshift((value & 0x7f) | 0x80);
    }
    bytes.push(...group);
  }
  return tlv(TAG.oid, Buffer.from(bytes));
}

/** A non-negative INTEGER from big-endian bytes in minimal DER form (leading zeros stripped, sign byte added). */
export function unsignedInteger(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const value = Buffer.from(bytes.subarray(start));
  if (value.length === 0) return tlv(TAG.integer, Buffer.from([0]));
  const first = value[0] ?? 0;
  return tlv(TAG.integer, first >= 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function ascii(tag: number, text: string): Buffer {
  return tlv(tag, Buffer.from(text, 'ascii'));
}

/** Name ::= SEQUENCE OF SET OF AttributeTypeAndValue – here exactly `CN=<commonName>`. */
function commonName(name: string): Buffer {
  return sequence(
    tlv(TAG.set, sequence(objectIdentifier(COMMON_NAME_OID), tlv(TAG.utf8String, Buffer.from(name, 'utf8')))),
  );
}

/** 16 random bytes, positive and not zero (RFC 5280 §4.1.2.2). */
export function randomSerial(): Buffer {
  for (;;) {
    const serial = randomBytes(SERIAL_BYTES);
    if (serial.some((byte) => byte !== 0)) return serial;
  }
}

/**
 * The self-signed certificate of §B.4 for an ML-DSA-87 key pair: v3, random 16-byte serial,
 * issuer = subject = `CN=parallax`, valid 2000 … 9999, no extensions. Returns the DER.
 */
export function buildSelfSignedCertificate(
  privateKey: KeyObject,
  publicKey: KeyObject,
  serial: Uint8Array = randomSerial(),
): Buffer {
  if (privateKey.asymmetricKeyType !== 'ml-dsa-87' || publicKey.asymmetricKeyType !== 'ml-dsa-87') {
    throw new TypeError('certificate keys must be ML-DSA-87');
  }
  const algorithm = sequence(objectIdentifier(ML_DSA_87_OID));
  const name = commonName(CERTIFICATE_COMMON_NAME);
  const validity = sequence(
    ascii(TAG.utcTime, CERTIFICATE_NOT_BEFORE),
    ascii(TAG.generalizedTime, CERTIFICATE_NOT_AFTER),
  );
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const tbs = sequence(
    tlv(TAG.explicit0, unsignedInteger(Uint8Array.of(2))),
    unsignedInteger(serial),
    algorithm,
    name,
    validity,
    name,
    spki,
  );
  const signature = sign(null, tbs, privateKey);
  return sequence(tbs, algorithm, tlv(TAG.bitString, Buffer.from([0]), signature));
}
