import { describe, expect, it } from 'vitest';
import { tlsSelfTest } from './selfTest';

describe('TLS self-test of the check `tls` (§B.11)', () => {
  it('passes on this Node/OpenSSL (ML-DSA-87 sign/verify, flipped bits fail, loopback mTLS handshake)', async () => {
    expect(await tlsSelfTest()).toBeNull();
  });
});
