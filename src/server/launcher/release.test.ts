import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReleaseInfo, RELEASE_FILE, ReleaseInfoError, type ReleaseInfo } from './release';

const SAMPLE: ReleaseInfo = {
  schemaVersion: 1,
  name: 'parallax',
  version: '1.0.0-rc.1',
  commit: 'a'.repeat(40),
  buildId: '1.0.0-rc.1+aaaaaaa',
  minNode: '24.5.0',
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
