import { generateKeyPairSync, sign } from 'node:crypto';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { comparePackageFiles, hashFiles, walkPackage } from './packageFiles';
import { verifyReleaseSignature } from './release';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'parallax-package-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<string> {
  const file = path.join(dir, ...rel.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

const HASH_A = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb';
const HASH_B = '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d';

describe('walkPackage / hashFiles', () => {
  it('lists plain files sorted with their SHA-256', async () => {
    await put('b.txt', 'b');
    await put('dist/a.js', 'a');
    const walk = await walkPackage(dir);
    expect(walk.problems).toEqual([]);
    expect(walk.files).toEqual([
      { rel: 'b.txt', size: 1 },
      { rel: 'dist/a.js', size: 1 },
    ]);
    expect(await hashFiles(dir, walk.files)).toEqual({ 'b.txt': HASH_B, 'dist/a.js': HASH_A });
  });

  it('reports links, junctions and hardlinks', async () => {
    const target = await put('real/file.txt', 'x');
    await symlink(path.join(dir, 'real'), path.join(dir, 'junction'), 'junction');
    await link(target, path.join(dir, 'hard.txt'));
    const walk = await walkPackage(dir);
    expect(walk.problems).toContainEqual('junction: link or junction');
    expect(walk.problems).toContainEqual('hard.txt: hardlink (2 names)');
  });

  it('reports names outside printable ASCII (Windows tar 3.8.9 crashes on them)', async () => {
    await put('node_modules/x/fixtures/snow ☃/a.txt', 'a');
    await put('node_modules/x/café.js', 'b');
    await put('node_modules/x/plain name (1).js', 'c');
    const walk = await walkPackage(dir);
    expect(walk.problems).toEqual([
      'node_modules/x/café.js: name outside printable ASCII',
      'node_modules/x/fixtures/snow ☃: name outside printable ASCII',
    ]);
  });
});

describe('comparePackageFiles', () => {
  it('finds missing, changed and extra files; release.json itself is ignored', async () => {
    await put('dist/a.js', 'a');
    await put('b.txt', 'changed');
    await put('extra.js', 'x');
    await put('release.json', '{}');
    const walk = await walkPackage(dir);
    const actual = await hashFiles(dir, walk.files);
    const listed = { 'dist/a.js': HASH_A, 'b.txt': HASH_B, 'gone.js': HASH_A };
    expect(comparePackageFiles(walk, actual, listed, ['release.json', 'release.json.sig']).sort()).toEqual([
      'b.txt: changed',
      'extra.js: not in release.json',
      'gone.js: missing',
    ]);
  });

  it('names of Object.prototype are not listed files', async () => {
    await put('toString', 'x');
    await put('constructor', 'y');
    const walk = await walkPackage(dir);
    expect(comparePackageFiles(walk, await hashFiles(dir, walk.files), {}, []).sort()).toEqual([
      'constructor: not in release.json',
      'toString: not in release.json',
    ]);
  });

  it('is empty for an intact package', async () => {
    await put('dist/a.js', 'a');
    const walk = await walkPackage(dir);
    expect(comparePackageFiles(walk, await hashFiles(dir, walk.files), { 'dist/a.js': HASH_A }, [])).toEqual(
      [],
    );
  });
});

describe('verifyReleaseSignature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x ?? '';
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x ?? '';
  const data = Buffer.from('{"version":"1.0.0"}\n');
  const signature = sign(null, data, privateKey).toString('base64');

  it('accepts the signature of a listed key over the exact bytes', () => {
    expect(verifyReleaseSignature(data, signature, [x])).toBe(true);
    expect(verifyReleaseSignature(data, `${signature}\n`, [other, x])).toBe(true);
  });

  it('refuses other bytes, other keys, malformed signatures and keys, and an empty key list', () => {
    expect(verifyReleaseSignature(Buffer.from('{"version":"1.0.1"}\n'), signature, [x])).toBe(false);
    expect(verifyReleaseSignature(data, signature, [other])).toBe(false);
    expect(verifyReleaseSignature(data, 'abc', [x])).toBe(false);
    expect(verifyReleaseSignature(data, signature, ['not-a-key'])).toBe(false);
    expect(verifyReleaseSignature(data, signature, [])).toBe(false);
  });
});
