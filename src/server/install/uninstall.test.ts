import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installPackage } from './install';
import { fakeProvideSdk, makeTestKey, makeTestPackage, testBuildId } from './testPackage';
import { uninstall } from './uninstall';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function installed(): Promise<string> {
  const base = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp86-uninstall-'));
  temps.push(base);
  const key = makeTestKey();
  const pkg = path.join(base, 'parallax-1.0.0');
  await makeTestPackage(pkg, { version: '1.0.0', key });
  const root = path.join(base, 'Parallax');
  await installPackage(
    { packageDir: pkg, root, keys: [key.x], nodeVersion: '26.12.0' },
    {
      provideSdk: fakeProvideSdk([]),
      startMenu: () => Promise.resolve(null),
      runningBuildId: () => Promise.resolve(null),
      log: () => undefined,
    },
  );
  await mkdir(path.join(root, 'cache'), { recursive: true });
  return root;
}

describe('uninstall (WP-86, WP-83 §8.1)', () => {
  it('removes the entries and the root', async () => {
    const root = await installed();
    const removed: string[] = [];
    const result = await uninstall(root, {
      removeEntries: (r) => {
        removed.push(r);
        return Promise.resolve([]);
      },
      runningBuildId: () => Promise.resolve(null),
    });
    expect(result).toEqual({ problems: [], leftovers: [] });
    expect(removed).toEqual([root]);
    await expect(readdir(root)).rejects.toThrow();
  });

  it("keeps files that are not Parallax's and reports entry problems", async () => {
    const root = await installed();
    await writeFile(path.join(root, 'my notes.txt'), 'mine');
    const result = await uninstall(root, {
      removeEntries: () => Promise.resolve(['protocol handler: access denied']),
      runningBuildId: () => Promise.resolve(null),
    });
    expect(result).toEqual({ problems: ['protocol handler: access denied'], leftovers: ['my notes.txt'] });
    expect(await readdir(root)).toEqual(['my notes.txt']);
  });

  it('refuses while a server of this installation runs, and for a folder that is no installation', async () => {
    const root = await installed();
    let asked = false;
    await expect(
      uninstall(root, {
        removeEntries: () => {
          asked = true;
          return Promise.resolve([]);
        },
        runningBuildId: () => Promise.resolve(testBuildId('1.0.0')),
      }),
    ).rejects.toThrow(/Parallax 1\.0\.0 is running from/);
    expect(asked).toBe(false);
    const other = path.join(path.dirname(root), 'other');
    await mkdir(other);
    await expect(
      uninstall(other, {
        removeEntries: () => Promise.resolve([]),
        runningBuildId: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(/is no Parallax installation/);
  });
});
