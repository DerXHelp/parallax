import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyReleaseSignature } from '../../src/server/launcher/release';
import { runFile } from '../../src/server/lib/process';

// The CI job runs this file with plain node (type stripping, no install): so does the test.
const SIGN = path.join(import.meta.dirname, 'sign.ts');

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'parallax-sign-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sign(args: readonly string[], key: string | null) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete env.RELEASE_SIGNING_KEY;
  if (key !== null) env.RELEASE_SIGNING_KEY = key;
  return runFile(process.execPath, [SIGN, ...args], { cwd: dir, env, timeoutMs: 30_000 });
}

describe('scripts/release/sign.ts (plain node)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const x = publicKey.export({ format: 'jwk' }).x ?? '';

  it('signs files so that verifyReleaseSignature accepts them, without printing the key', async () => {
    const file = path.join(dir, 'release.json');
    await writeFile(file, '{"version":"1.0.0"}\n');
    const result = await sign(['sign', file], pem);
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('PRIVATE KEY');
    const signature = await readFile(`${file}.sig`, 'utf8');
    expect(verifyReleaseSignature(await readFile(file), signature, [x])).toBe(true);
  });

  it('refuses to run without the key', async () => {
    const file = path.join(dir, 'a.json');
    await writeFile(file, '{}');
    const result = await sign(['sign', file], null);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('RELEASE_SIGNING_KEY is not set');
  });

  it('writes latest.json with size, hashes, notes and the download URL', async () => {
    const zip = path.join(dir, 'parallax-1.0.0-rc.1-win.zip');
    await writeFile(zip, 'zip');
    await writeFile(path.join(dir, 'notes.md'), '### Neu\n- Something.\n');
    await writeFile(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
    await writeFile(
      path.join(dir, 'release.json'),
      JSON.stringify({ version: '1.0.0-rc.1', minNode: '26.9.0' }),
    );
    const out = path.join(dir, 'latest.json');
    const result = await sign(
      [
        'latest',
        '--zip',
        zip,
        '--version',
        '1.0.0-rc.1',
        '--release',
        'release.json',
        '--notes',
        'notes.md',
        '--changelog',
        'CHANGELOG.md',
        '--out',
        out,
      ],
      null,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      version: '1.0.0-rc.1',
      prerelease: true,
      minNode: '26.9.0',
      url: 'https://github.com/DerXHelp/parallax/releases/download/v1.0.0-rc.1/parallax-1.0.0-rc.1-win.zip',
      size: 3,
      sha256: createHash('sha256').update('zip').digest('hex'),
      changelogSha256: createHash('sha256').update('# Changelog\n').digest('hex'),
      notes: '### Neu\n- Something.',
    });

    // ADR-232: without a valid minNode in release.json no latest.json is written.
    await writeFile(
      path.join(dir, 'release.json'),
      JSON.stringify({ version: '1.0.0-rc.1', minNode: '26.9' }),
    );
    await rm(out);
    const refused = await sign(
      [
        'latest',
        '--zip',
        zip,
        '--version',
        '1.0.0-rc.1',
        '--release',
        'release.json',
        '--notes',
        'notes.md',
        '--changelog',
        'CHANGELOG.md',
        '--out',
        out,
      ],
      null,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('no valid minNode');
    await expect(readFile(out, 'utf8')).rejects.toThrow();
  });
});
