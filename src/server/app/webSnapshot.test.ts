import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../lib/logger';
import { makeTempHome } from '../http/testServer';
import {
  WEB_BUILD_INFO_FILE,
  WEB_SNAPSHOT_DIR,
  prepareWebRoot,
  readWebBuildId,
  snapshotDirName,
} from './webSnapshot';

const log = createLogger({ level: 'silent' });
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** A temp root with `dist/web` (index, asset, build.json) and an empty `home`. */
async function setup(buildId: string | null): Promise<{ web: string; home: string }> {
  const root = await makeTempHome('r3-websnapshot-');
  dirs.push(root);
  const web = path.join(root, 'dist', 'web');
  await mkdir(path.join(web, 'assets'), { recursive: true });
  await writeFile(path.join(web, 'index.html'), '<title>old</title>');
  await writeFile(path.join(web, 'assets', 'index-aaa.js'), 'old();');
  if (buildId !== null) await writeFile(path.join(web, WEB_BUILD_INFO_FILE), JSON.stringify({ buildId }));
  const home = path.join(root, 'home');
  await mkdir(home);
  return { web, home };
}

describe('web UI snapshot (V2-03)', () => {
  it('serves a copy in PARALLAX_HOME/ui/<buildId>; a later rebuild of dist/web does not touch it', async () => {
    const { web, home } = await setup('1.0.0+abc');
    const root = await prepareWebRoot({ source: web, home, buildId: '1.0.0+abc', log });
    expect(root).toBe(path.join(home, WEB_SNAPSHOT_DIR, '1.0.0+abc'));
    expect(await readFile(path.join(root, 'assets', 'index-aaa.js'), 'utf8')).toBe('old();');
    expect(await readWebBuildId(root)).toBe('1.0.0+abc');

    // `pnpm build` empties and rewrites dist/web while the server runs.
    await rm(web, { recursive: true, force: true });
    await mkdir(path.join(web, 'assets'), { recursive: true });
    await writeFile(path.join(web, 'index.html'), '<title>new</title>');
    await writeFile(path.join(web, WEB_BUILD_INFO_FILE), JSON.stringify({ buildId: '1.0.0+def' }));
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('<title>old</title>');
    expect(await readFile(path.join(root, 'assets', 'index-aaa.js'), 'utf8')).toBe('old();');
  });

  it('reuses the snapshot of the same build and drops snapshots of older builds', async () => {
    const { web, home } = await setup('1.0.0+abc');
    const first = await prepareWebRoot({ source: web, home, buildId: '1.0.0+abc', log });
    await writeFile(path.join(first, 'marker'), 'kept');
    expect(await prepareWebRoot({ source: web, home, buildId: '1.0.0+abc', log })).toBe(first);
    expect(await readFile(path.join(first, 'marker'), 'utf8')).toBe('kept');

    await writeFile(path.join(web, WEB_BUILD_INFO_FILE), JSON.stringify({ buildId: '1.0.1+def' }));
    await mkdir(path.join(home, WEB_SNAPSHOT_DIR, '.tmp-1-2'));
    const second = await prepareWebRoot({ source: web, home, buildId: '1.0.1+def', log });
    expect(await readdir(path.join(home, WEB_SNAPSHOT_DIR))).toEqual([path.basename(second)]);
  });

  it('serves dist/web directly for unbundled runs and for a web UI of another build', async () => {
    const { web, home } = await setup('1.0.0+abc');
    expect(await prepareWebRoot({ source: web, home, buildId: 'dev', log })).toBe(web);
    expect(await prepareWebRoot({ source: web, home, buildId: '1.0.0+other', log })).toBe(web);
    const unmarked = await setup(null);
    expect(
      await prepareWebRoot({ source: unmarked.web, home: unmarked.home, buildId: '1.0.0+abc', log }),
    ).toBe(unmarked.web);
    expect(await readdir(home)).toEqual([]);
  });

  it('a failing copy falls back to dist/web (never throws)', async () => {
    const { web, home } = await setup('1.0.0+abc');
    // A file where the snapshot folder must be created.
    await writeFile(path.join(home, WEB_SNAPSHOT_DIR), 'not a folder');
    expect(await prepareWebRoot({ source: web, home, buildId: '1.0.0+abc', log })).toBe(web);
  });

  it('folder names keep build ids readable and safe', () => {
    expect(snapshotDirName('0.0.0+5f15036f480c.dirty-1a2b3c4d')).toBe('0.0.0+5f15036f480c.dirty-1a2b3c4d');
    expect(snapshotDirName('a/b\\c:d')).toBe('a_b_c_d');
    expect(snapshotDirName('x.')).toBe('x_');
  });
});
