import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyReleaseSignature } from '../../src/server/launcher/release';
import { runFile } from '../../src/server/lib/process';
import { archiveTool, extractZip, listZip } from '../../src/server/update/zip';

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

describe('scripts/release/sign.ts tarball (Linux asset, WP-108)', () => {
  // A last part over 100 bytes needs a pax header; a path over 100 bytes the ustar prefix.
  const LONG = `node_modules/${'f'.repeat(120)}.js`;
  const DEEP = `${'deep-folder-name/'.repeat(5)}file.js`;

  async function packageFolder(): Promise<string> {
    const folder = path.join(dir, 'pkg', 'parallax-1.2.0');
    const files: Record<string, string> = {
      'release.json': JSON.stringify({ version: '1.2.0', createdAt: '2026-11-21T10:00:00.000Z' }),
      'release.json.sig': 'sig\n',
      'install.sh': '#!/bin/sh\necho install\n',
      'root/parallax': '#!/bin/sh\necho start\n',
      'dist/server.js': 'export {};\n',
      'node_modules/a b/index.js': 'x'.repeat(1000),
      [LONG]: 'long\n',
      [DEEP]: 'deep\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(folder, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return folder;
  }

  it('packs the folder so that the update of this platform lists and unpacks it', async () => {
    const folder = await packageFolder();
    const out = path.join(dir, 'parallax-1.2.0-linux-x64.tar.gz');
    const result = await sign(['tarball', folder, out], null);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    // Deterministic: the same folder gives the same bytes.
    const again = path.join(dir, 'again', 'parallax-1.2.0-linux-x64.tar.gz');
    await mkdir(path.dirname(again));
    expect((await sign(['tarball', folder, again], null)).exitCode).toBe(0);
    expect((await readFile(again)).equals(await readFile(out))).toBe(true);

    // bsdtar (Windows tar.exe) reads a tar.gz as well; Linux takes GNU tar with -z.
    const tool = archiveTool();
    const listing = await listZip(out, '1.2.0', { cwd: dir, tool });
    expect(listing).toMatchObject({ rootDir: 'parallax-1.2.0', version: '1.2.0', entries: 18 });
    const target = path.join(dir, 'unpacked');
    await mkdir(target);
    await extractZip(out, target, { tool });
    const unpacked = path.join(target, 'parallax-1.2.0');
    expect(await readFile(path.join(unpacked, ...LONG.split('/')), 'utf8')).toBe('long\n');
    expect(await readFile(path.join(unpacked, ...DEEP.split('/')), 'utf8')).toBe('deep\n');
    expect(await readFile(path.join(unpacked, 'node_modules', 'a b', 'index.js'), 'utf8')).toBe(
      'x'.repeat(1000),
    );
    if (process.platform !== 'win32') {
      expect((await stat(path.join(unpacked, 'install.sh'))).mode & 0o111).not.toBe(0);
      expect((await stat(path.join(unpacked, 'root', 'parallax'))).mode & 0o111).not.toBe(0);
      expect((await stat(path.join(unpacked, 'dist', 'server.js'))).mode & 0o111).toBe(0);
    }
  });

  it('refuses a wrong folder or file name', async () => {
    const folder = await packageFolder();
    const wrong = await sign(['tarball', folder, path.join(dir, 'parallax-1.2.0.tar.gz')], null);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain('parallax-1.2.0-linux-x64.tar.gz');
    const other = path.join(dir, 'other');
    await mkdir(other);
    const refused = await sign(['tarball', other, path.join(dir, 'x.tar.gz')], null);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('no folder parallax-<version>');
  });

  it('latest.json lists every asset; the top level stays the Windows zip', async () => {
    const zip = path.join(dir, 'parallax-1.2.0-win.zip');
    const tarball = path.join(dir, 'parallax-1.2.0-linux-x64.tar.gz');
    await writeFile(zip, 'zip');
    await writeFile(tarball, 'tarball');
    await writeFile(path.join(dir, 'notes.md'), '- Linux.\n');
    await writeFile(path.join(dir, 'CHANGELOG.md'), '# Changelog\n');
    await writeFile(path.join(dir, 'release.json'), JSON.stringify({ version: '1.2.0', minNode: '26.9.0' }));
    const out = path.join(dir, 'latest.json');
    const args = ['--version', '1.2.0', '--release', 'release.json', '--notes', 'notes.md'];
    const result = await sign(
      ['latest', '--zip', zip, '--tarball', tarball, ...args, '--changelog', 'CHANGELOG.md', '--out', out],
      null,
    );
    expect(result.exitCode).toBe(0);
    const base = 'https://github.com/DerXHelp/parallax/releases/download/v1.2.0';
    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
      url: `${base}/parallax-1.2.0-win.zip`,
      size: 3,
      assets: [
        { name: 'parallax-1.2.0-win.zip', url: `${base}/parallax-1.2.0-win.zip`, size: 3 },
        {
          name: 'parallax-1.2.0-linux-x64.tar.gz',
          url: `${base}/parallax-1.2.0-linux-x64.tar.gz`,
          size: 7,
          sha256: createHash('sha256').update('tarball').digest('hex'),
        },
      ],
    });
    const misnamed = await sign(
      ['latest', '--zip', zip, '--tarball', zip, ...args, '--changelog', 'CHANGELOG.md', '--out', out],
      null,
    );
    expect(misnamed.exitCode).toBe(1);
  });
});
