import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readReleaseInfo,
  RELEASE_FILE,
  RELEASE_PUBLIC_KEYS,
  ReleaseInfoError,
  type ReleaseInfo,
} from './release';

const SAMPLE: ReleaseInfo = {
  schemaVersion: 1,
  name: 'parallax',
  version: '1.0.0-rc.1',
  commit: 'a'.repeat(40),
  buildId: '1.0.0-rc.1+aaaaaaa',
  minNode: '26.9.0',
  createdAt: '2026-11-17T10:00:00.000Z',
  schemas: { 'settings.json': 'b'.repeat(64) },
  sdk: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.322', integrity: 'sha512-AbC+/x==' },
  files: { 'dist/server.js': 'c'.repeat(64) },
};

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'parallax-release-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('RELEASE_PUBLIC_KEYS', () => {
  it('holds valid, distinct Ed25519 keys (JWK x, raw 32 bytes)', () => {
    expect(RELEASE_PUBLIC_KEYS.length).toBeGreaterThan(0);
    expect(new Set(RELEASE_PUBLIC_KEYS).size).toBe(RELEASE_PUBLIC_KEYS.length);
    for (const x of RELEASE_PUBLIC_KEYS) {
      const raw = Buffer.from(x, 'base64url');
      expect(raw).toHaveLength(32);
      expect(raw.toString('base64url')).toBe(x);
      expect(
        createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }).asymmetricKeyType,
      ).toBe('ed25519');
    }
  });

  it('key 1 matches the fingerprint the user saw when creating it (17.11.2026)', () => {
    const raw = Buffer.from(RELEASE_PUBLIC_KEYS[0] ?? '', 'base64url');
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '51c9335f62940cc6354c975a82549be63dafd87f9c6ec7631069ff8c9312b39e',
    );
  });
});

describe('readReleaseInfo', () => {
  it('returns null in a checkout (no release.json)', async () => {
    await expect(readReleaseInfo(dir)).resolves.toBeNull();
  });

  it('reads a valid release.json and strips unknown keys of newer writers', async () => {
    await writeFile(path.join(dir, RELEASE_FILE), JSON.stringify({ ...SAMPLE, later: true }));
    await expect(readReleaseInfo(dir)).resolves.toEqual(SAMPLE);
  });

  it.each<[string, string]>([
    ['broken JSON', '{'],
    ['wrong schema version', JSON.stringify({ ...SAMPLE, schemaVersion: 2 })],
    ['short commit', JSON.stringify({ ...SAMPLE, commit: 'abc' })],
    ['bad file hash', JSON.stringify({ ...SAMPLE, files: { 'dist/server.js': 'xyz' } })],
    ['bad integrity', JSON.stringify({ ...SAMPLE, sdk: { ...SAMPLE.sdk, integrity: 'sha1-abc' } })],
  ])('throws ReleaseInfoError for %s', async (_name, text) => {
    await writeFile(path.join(dir, RELEASE_FILE), text);
    await expect(readReleaseInfo(dir)).rejects.toBeInstanceOf(ReleaseInfoError);
  });
});
