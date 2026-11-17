import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestKey, makeTestPackage } from '../install/testPackage';
import { zipFolders } from './testRelease';
import {
  ZIP_MAX_ENTRIES,
  ZIP_MAX_UNPACKED_BYTES,
  ZipError,
  extractZip,
  listZip,
  parseZipListing,
} from './zip';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-zip-'));
  temps.push(dir);
  return dir;
}

function dir(name: string): string {
  return `drwxrwxrwx  0 0      0           0 Nov 17 19:44 ${name}`;
}
function file(name: string, size = 6): string {
  return `-rw-rw-rw-  0 0      0 ${String(size).padStart(11)} Nov 17 19:44 ${name}`;
}
function listing(...lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`;
}

function problem(stdout: string, version: string | null = '1.2.3'): string {
  try {
    parseZipListing(stdout, version);
  } catch (error) {
    if (error instanceof ZipError) return error.reason;
    throw error;
  }
  return 'ok';
}

describe('parseZipListing', () => {
  it('accepts one root folder parallax-<v>/ with files and folders', () => {
    const out = listing(
      dir('parallax-1.2.3/'),
      dir('parallax-1.2.3/dist/'),
      file('parallax-1.2.3/dist/a.js', 6),
      dir('parallax-1.2.3/dist/sub dir/'),
      file('parallax-1.2.3/dist/sub dir/b c.txt', 3000),
    );
    expect(parseZipListing(out, '1.2.3')).toEqual({
      rootDir: 'parallax-1.2.3',
      version: '1.2.3',
      entries: 5,
      bytes: 3006,
    });
    expect(parseZipListing(out, null).version).toBe('1.2.3');
  });

  it('reads dates of other forms (older files, other locales)', () => {
    const old = '-rw-rw-rw-  0 0      0          10 Nov 17  2025 parallax-1.2.3/a';
    const short = '-rw-rw-rw-  0 0      0          10 2025-11-17 parallax-1.2.3/b';
    expect(parseZipListing(listing(old, short), '1.2.3').bytes).toBe(20);
  });

  it('refuses .., absolute paths, drives and backslashes', () => {
    expect(problem(listing(file('parallax-1.2.3/../evil.js')))).toBe('layout');
    expect(problem(listing(file('parallax-1.2.3/./a')))).toBe('layout');
    expect(problem(listing(file('parallax-1.2.3//a')))).toBe('layout');
    expect(problem(listing(file('/parallax-1.2.3/a')))).toBe('layout');
    expect(problem(listing(file('parallax-1.2.3/C:/a')))).toBe('layout');
    expect(problem(listing(file('parallax-1.2.3/a\\..\\..\\b')))).toBe('layout');
  });

  it('refuses a second root folder, a wrong version and a file as root', () => {
    expect(problem(listing(dir('parallax-1.2.3/'), dir('other/'), file('other/a')))).toBe('layout');
    expect(problem(listing(dir('parallax-1.2.3/'), file('Parallax-1.2.3/a')))).toBe('layout');
    expect(problem(listing(dir('parallax-1.2.4/')))).toBe('layout');
    expect(problem(listing(file('parallax-1.2.3')))).toBe('layout');
    expect(problem(listing(dir('parallax-latest/')), null)).toBe('layout');
    expect(problem(listing(dir('parallax-1.2.3/'), dir('parallax-1.2.4/')), null)).toBe('layout');
  });

  it('refuses links and other entry types', () => {
    const link = 'lrwxrwxrwx  0 0      0           0 Nov 17 19:44 parallax-1.2.3/a -> C:/Windows';
    const hard = 'hrw-rw-rw-  0 0      0           0 Nov 17 19:44 parallax-1.2.3/a link to parallax-1.2.3/b';
    expect(problem(listing(link))).toBe('layout');
    expect(problem(listing(hard))).toBe('layout');
  });

  it('refuses too many entries, too many bytes, empty and unreadable listings', () => {
    const many = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => file(`parallax-1.2.3/f${String(i)}`));
    expect(problem(listing(...many))).toBe('too_large');
    const half = Math.floor(ZIP_MAX_UNPACKED_BYTES / 2) + 1;
    expect(problem(listing(file('parallax-1.2.3/a', half), file('parallax-1.2.3/b', half)))).toBe(
      'too_large',
    );
    expect(problem('')).toBe('zip');
    expect(problem('tar.exe: Error opening archive\r\n')).toBe('zip');
  });

  it('a name with " parallax-" inside cannot fake the root: the plain listing must agree', () => {
    const tricky = 'x parallax-1.2.3/evil.js';
    const verbose = listing(dir('parallax-1.2.3/'), file(tricky));
    // The verbose line alone reads like a file below the root …
    expect(parseZipListing(verbose, '1.2.3').entries).toBe(2);
    // … the plain `tar -t` names show the real one.
    const names = listing('parallax-1.2.3/', tricky);
    expect(() => parseZipListing(verbose, '1.2.3', names)).toThrow(ZipError);
    expect(() => parseZipListing(verbose, '1.2.3', listing('parallax-1.2.3/'))).toThrow(
      /listings of the zip differ/u,
    );
    const good = listing(dir('parallax-1.2.3/'), file('parallax-1.2.3/a.js'));
    expect(parseZipListing(good, '1.2.3', listing('parallax-1.2.3/', 'parallax-1.2.3/a.js')).entries).toBe(2);
  });
});

describe('listZip / extractZip (tar.exe)', () => {
  it('lists and unpacks a package zip made like the release', async () => {
    const base = await temp();
    await makeTestPackage(path.join(base, 'src', 'parallax-2.0.0'), { version: '2.0.0', key: makeTestKey() });
    const zip = path.join(base, 'parallax-2.0.0-win.zip');
    await zipFolders(path.join(base, 'src'), ['parallax-2.0.0'], zip);
    const found = await listZip(zip, '2.0.0', { cwd: base });
    expect(found.rootDir).toBe('parallax-2.0.0');
    expect(found.entries).toBeGreaterThan(5);
    const target = path.join(base, 'unpack');
    await mkdir(target);
    await extractZip(zip, target, {});
    expect(await readdir(target)).toEqual(['parallax-2.0.0']);
    expect(await readdir(path.join(target, 'parallax-2.0.0'))).toContain('release.json');
  });

  it('refuses a zip with a second root folder and a file that is no zip', async () => {
    const base = await temp();
    await makeTestPackage(path.join(base, 'src', 'parallax-2.0.0'), { version: '2.0.0', key: makeTestKey() });
    await mkdir(path.join(base, 'src', 'extra'));
    await writeFile(path.join(base, 'src', 'extra', 'x.txt'), 'x');
    const zip = path.join(base, 'two.zip');
    await zipFolders(path.join(base, 'src'), ['parallax-2.0.0', 'extra'], zip);
    await expect(listZip(zip, '2.0.0', { cwd: base })).rejects.toMatchObject({ reason: 'layout' });
    const junk = path.join(base, 'junk.zip');
    await writeFile(junk, 'this is no zip');
    await expect(listZip(junk, null, { cwd: base })).rejects.toMatchObject({ reason: 'zip' });
  });
});
