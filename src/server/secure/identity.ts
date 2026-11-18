/**
 * Own identities (docs/wp/WP-76.md §B.4): an ML-DSA-87 key pair with its self-signed certificate,
 * created once and kept together (the controlling computer pins the whole certificate, Review t5).
 * `makeIdentity` is the check after loading: key type, certificate key = the private key's public
 * key, certificate verifies with it, issuer = subject = `CN=parallax`.
 */
import { X509Certificate, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { CERTIFICATE_COMMON_NAME, buildSelfSignedCertificate } from './der';
import { bytesEqual, certificatePem, pinOfSpki, spkiOfPublicKey } from './pins';
import type { Identity, KeyFilePurpose } from './ports';
import { KEY_ALGORITHM } from './tlsProfile';

/** Why a key and a certificate do not form a valid identity (no secrets in the message). */
export type IdentityProblem = 'key_type' | 'certificate' | 'key_mismatch' | 'signature' | 'name';

export class IdentityError extends Error {
  readonly problem: IdentityProblem;

  constructor(problem: IdentityProblem) {
    super(`identity check failed: ${problem}`);
    this.name = 'IdentityError';
    this.problem = problem;
  }
}

const EXPECTED_NAME = `CN=${CERTIFICATE_COMMON_NAME}`;

/** Checks key and certificate (throws IdentityError) and returns the frozen identity. */
export function makeIdentity(
  purpose: KeyFilePurpose,
  privateKey: KeyObject,
  certificateDer: Uint8Array,
): Identity {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== KEY_ALGORITHM) {
    throw new IdentityError('key_type');
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificateDer);
  } catch {
    throw new IdentityError('certificate');
  }
  if (certificate.publicKey.asymmetricKeyType !== KEY_ALGORITHM) throw new IdentityError('key_type');
  const publicKey = createPublicKey(privateKey);
  const spki = spkiOfPublicKey(publicKey);
  if (!bytesEqual(spkiOfPublicKey(certificate.publicKey), spki)) throw new IdentityError('key_mismatch');
  if (!certificate.verify(publicKey)) throw new IdentityError('signature');
  if (certificate.subject !== EXPECTED_NAME || certificate.issuer !== EXPECTED_NAME) {
    throw new IdentityError('name');
  }
  const der = Buffer.from(certificateDer);
  return Object.freeze({
    purpose,
    privateKey,
    certificateDer: der,
    certificatePem: certificatePem(der),
    pin: pinOfSpki(spki),
  });
}

/** A new key pair and certificate in memory only (stored later with `IdentityStore`). */
export function generateIdentity(purpose: KeyFilePurpose): Identity {
  const { privateKey, publicKey } = generateKeyPairSync(KEY_ALGORITHM);
  return makeIdentity(purpose, privateKey, buildSelfSignedCertificate(privateKey, publicKey));
}
