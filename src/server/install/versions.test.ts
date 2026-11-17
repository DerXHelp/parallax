import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupVersions, folderStamp, listInstalledVersions, versionOfBuild } from './versions';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(names: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp86-versions-'));
  temps.push(dir);
  for (const name of names) await mkdir(path.join(dir, 'versions', name, 'dist'), { recursive: true });
  return dir;
}

const NOW = new Date(2026, 10, 17, 9, 30, 0);

describe('version folders (WP-86, WP-83 §8.1)', () => {
  it('lists versions with their build ids, skipping staging, trash and foreign names', async () => {
    const dir = await root(['1.0.0', '1.1.0-rc.1', '.staging-1.2.0-x', 'notes']);
    await writeFile(path.join(dir, 'versions', '1.0.0', 'release.json'), '{"broken":');
    const installed = await listInstalledVersions(dir);
    expect(installed).toEqual([
      { version: '1.0.0', buildId: null },
      { version: '1.1.0-rc.1', buildId: null },
    ]);
    expect(versionOfBuild(installed, null)).toBeNull();
    expect(await listInstalledVersions(path.join(dir, 'missing'))).toEqual([]);
  });

  it('deletes unprotected versions and old leftovers, keeps fresh staging and foreign folders', async () => {
    const dir = await root([
      '1.0.0',
      '1.1.0',
      '1.2.0',
      '1.3.0',
      '.trash-20261101-1.0.0',
      '.staging-1.4.0-old',
      '.staging-1.4.0-new',
      'notes',
    ]);
    const old = new Date(NOW.getTime() - 2 * 60 * 60_000);
    await utimes(path.join(dir, 'versions', '.staging-1.4.0-old'), old, old);
    const fresh = new Date(NOW.getTime() - 60_000);
    await utimes(path.join(dir, 'versions', '.staging-1.4.0-new'), fresh, fresh);
    const result = await cleanupVersions(dir, ['1.3.0', '1.2.0', null, '1.0.0'], NOW);
    expect(result).toEqual({ removed: ['1.1.0'], problems: [] });
    expect((await readdir(path.join(dir, 'versions'))).sort()).toEqual([
      '.staging-1.4.0-new',
      '1.0.0',
      '1.2.0',
      '1.3.0',
      'notes',
    ]);
  });

  it('stamps sort by time', () => {
    expect(folderStamp(NOW)).toBe('20261117-093000');
  });
});
