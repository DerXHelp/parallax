import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { BACKUPS_DIR, LAST_VERSION_FILE, readLastBuildId } from '../store/backup';
import { UPDATE_RESULT_FILE, updateResultSchema } from '../update/marker';
import { backupBeforeStart, versionOfBuildId } from './backupStep';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await makeTempHome('wp86-backup-');
  temps.push(dir);
  return dir;
}

const at = (minute: number) => ({ now: () => new Date(Date.UTC(2026, 10, 17, 9, minute, 0)) });

describe('backupBeforeStart (WP-86)', () => {
  it('a fresh home: no backup, the build id is remembered', async () => {
    const dir = await home();
    expect(await backupBeforeStart(dir, '1.0.0+aaa', at(0))).toEqual({ kind: 'unchanged' });
    expect(await readLastBuildId(dir)).toBe('1.0.0+aaa');
    expect(await readdir(path.join(dir, BACKUPS_DIR)).catch(() => [])).toEqual([]);
  });

  it('saves the stores when the build id changes, then not again for the same build', async () => {
    const dir = await home();
    await writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":1}');
    const first = await backupBeforeStart(dir, '1.0.0+aaa', at(0));
    expect(first).toMatchObject({ kind: 'saved', from: null, to: '1.0.0+aaa' });
    expect(await backupBeforeStart(dir, '1.0.0+aaa', at(1))).toEqual({ kind: 'unchanged' });
    const second = await backupBeforeStart(dir, '1.1.0+bbb', at(2));
    expect(second).toMatchObject({ kind: 'saved', from: '1.0.0+aaa', to: '1.1.0+bbb' });
    expect(await readdir(path.join(dir, BACKUPS_DIR))).toHaveLength(2);
    expect(await readLastBuildId(dir)).toBe('1.1.0+bbb');
  });

  it('keeps the three newest backups', async () => {
    const dir = await home();
    await writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":1}');
    for (let n = 0; n < 5; n++) await backupBeforeStart(dir, `1.${String(n)}.0+x`, at(n));
    expect(await readdir(path.join(dir, BACKUPS_DIR))).toHaveLength(3);
  });

  it('no build id: nothing; a failure is reported and the build id is not remembered', async () => {
    const dir = await home();
    expect(await backupBeforeStart(dir, null)).toEqual({ kind: 'unchanged' });
    await writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":1}');
    // `backups` as a file: the backup folder cannot be created.
    await writeFile(path.join(dir, BACKUPS_DIR), 'not a folder');
    const step = await backupBeforeStart(dir, '1.0.0+aaa', at(0));
    expect(step.kind).toBe('failed');
    expect(await readdir(dir)).not.toContain(LAST_VERSION_FILE);
  });

  it('WP-87b: in a package a saved backup writes the marker installed (from = version part of the build id)', async () => {
    const dir = await home();
    await writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":1}');
    await backupBeforeStart(dir, '1.0.0-rc.2+aaa', { ...at(0), installedVersion: '1.0.0-rc.2' });
    // The first backup has no previous build: from null.
    const first = updateResultSchema.parse(
      JSON.parse(await readFile(path.join(dir, UPDATE_RESULT_FILE), 'utf8')),
    );
    expect(first).toMatchObject({ outcome: 'installed', from: { version: null, buildId: null } });
    await rm(path.join(dir, UPDATE_RESULT_FILE));
    const step = await backupBeforeStart(dir, '1.0.0-rc.3+bbb', { ...at(1), installedVersion: '1.0.0-rc.3' });
    expect(step.kind).toBe('saved');
    const marker = updateResultSchema.parse(
      JSON.parse(await readFile(path.join(dir, UPDATE_RESULT_FILE), 'utf8')),
    );
    expect(marker).toEqual({
      schemaVersion: 1,
      outcome: 'installed',
      from: { version: '1.0.0-rc.2', buildId: '1.0.0-rc.2+aaa' },
      to: { version: '1.0.0-rc.3', buildId: '1.0.0-rc.3+bbb' },
      at: '2026-11-17T09:01:00.000Z',
      backupDir: step.kind === 'saved' ? step.dir : null,
      error: null,
      log: null,
    });
  });

  it('WP-87b: no marker in a checkout, for the same build or without a backup', async () => {
    const dir = await home();
    // Fresh home: nothing saved, no marker.
    await backupBeforeStart(dir, '1.0.0+aaa', { ...at(0), installedVersion: '1.0.0' });
    await writeFile(path.join(dir, 'settings.json'), '{"schemaVersion":1}');
    await backupBeforeStart(dir, '1.0.0+aaa', { ...at(1), installedVersion: '1.0.0' });
    await backupBeforeStart(dir, '1.1.0+bbb', at(2));
    expect(await readdir(dir)).not.toContain(UPDATE_RESULT_FILE);
    // A failing marker write never fails the step.
    const step = await backupBeforeStart(dir, '1.2.0+ccc', {
      ...at(3),
      installedVersion: '1.2.0',
      writeMarker: () => Promise.reject(new Error('disk full')),
    });
    expect(step.kind).toBe('saved');
  });

  it('versionOfBuildId: the release version before "+", else null', () => {
    expect(versionOfBuildId('1.0.1+abc')).toBe('1.0.1');
    expect(versionOfBuildId('1.0.0-rc.4+abc.dirty-1234')).toBe('1.0.0-rc.4');
    expect(versionOfBuildId('dev')).toBeNull();
    expect(versionOfBuildId('+abc')).toBeNull();
    expect(versionOfBuildId('0.1+abc')).toBeNull();
    expect(versionOfBuildId(null)).toBeNull();
  });
});
