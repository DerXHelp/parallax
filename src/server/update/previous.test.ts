import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNotRealUserFolder, versionDir, writeCurrent } from '../install/layout';
import { makeTestKey, makeTestPackage, testBuildId } from '../install/testPackage';
import { RELEASE_FILE, type ReleaseInfo } from '../launcher/release';
import { createBackup } from '../store/backup';
import { downgradeOf, findPrevious, schemasDiffer } from './previous';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp87a-previous-'));
  temps.push(dir);
  return dir;
}

const key = makeTestKey();
const SAME = { 'settings.json': 'b'.repeat(64) }; // makeTestPackage's schemas
const OTHER = { 'settings.json': 'c'.repeat(64) };

async function setup(previous: string | null = '1.0.0') {
  const base = await temp();
  const root = path.join(base, 'Programs', 'Parallax');
  assertNotRealUserFolder(root);
  const home = path.join(base, 'home');
  const own = await makeTestPackage(versionDir(root, '1.1.0'), { version: '1.1.0', key });
  if (previous !== null) await makeTestPackage(versionDir(root, previous), { version: previous, key });
  await writeCurrent(root, { schemaVersion: 1, version: '1.1.0', previous });
  return { root, home, own };
}

describe('schemasDiffer', () => {
  it('compares keys and values regardless of order', () => {
    expect(schemasDiffer({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(false);
    expect(schemasDiffer({ a: '1' }, { a: '2' })).toBe(true);
    expect(schemasDiffer({ a: '1' }, { a: '1', b: '2' })).toBe(true);
    expect(schemasDiffer({ a: '1', c: '2' }, { a: '1', b: '2' })).toBe(true);
  });
});

describe('findPrevious', () => {
  it('names current.json previous with equal schemas: no restore needed', async () => {
    const { root, home, own } = await setup();
    expect(await findPrevious(root, home, own)).toEqual({
      version: '1.0.0',
      needsRestore: false,
      backupAt: null,
    });
  });

  it('needs the backup for other schemas and finds it in both directions', async () => {
    const { root, home, own } = await setup();
    const changed: ReleaseInfo = { ...own, schemas: OTHER };
    expect(await findPrevious(root, home, changed)).toEqual({
      version: '1.0.0',
      needsRestore: true,
      backupAt: null,
    });
    const at = new Date('2026-11-20T08:00:00.000Z');
    await createBackup(home, { from: testBuildId('1.0.0'), to: own.buildId, now: at });
    expect(await findPrevious(root, home, changed)).toEqual({
      version: '1.0.0',
      needsRestore: true,
      backupAt: at.toISOString(),
    });
    // The other direction (from the running build to the previous one) does not count.
    const other = await setup();
    await createBackup(other.home, { from: other.own.buildId, to: testBuildId('1.0.0'), now: at });
    expect(
      (await findPrevious(other.root, other.home, { ...other.own, schemas: OTHER }))?.backupAt,
    ).toBeNull();
  });

  it('is null without previous, without its folder, for a broken folder or the running version', async () => {
    const none = await setup(null);
    expect(await findPrevious(none.root, none.home, none.own)).toBeNull();

    const gone = await setup();
    await rm(versionDir(gone.root, '1.0.0'), { recursive: true });
    expect(await findPrevious(gone.root, gone.home, gone.own)).toBeNull();

    const broken = await setup();
    await writeFile(path.join(versionDir(broken.root, '1.0.0'), RELEASE_FILE), '{broken');
    expect(await findPrevious(broken.root, broken.home, broken.own)).toBeNull();

    const self = await setup();
    await writeCurrent(self.root, { schemaVersion: 1, version: '1.0.0', previous: '1.1.0' });
    expect(await findPrevious(self.root, self.home, self.own)).toBeNull();

    const noCurrent = await temp();
    expect(await findPrevious(noCurrent, noCurrent, none.own)).toBeNull();
  });
});

describe('downgradeOf', () => {
  it('uses the backup of the change target → running', async () => {
    const { home, own } = await setup(null);
    const target: ReleaseInfo = { ...own, version: '1.0.0', buildId: testBuildId('1.0.0'), schemas: SAME };
    expect(await downgradeOf(home, own, target)).toEqual({ needsRestore: false, backupAt: null });
    expect((await downgradeOf(home, { ...own, schemas: OTHER }, target)).needsRestore).toBe(true);
  });
});
