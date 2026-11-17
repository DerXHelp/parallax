import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { BACKUPS_DIR, LAST_VERSION_FILE, readLastBuildId } from '../store/backup';
import { backupBeforeStart } from './backupStep';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function home(): Promise<string> {
  const dir = await makeTempHome('wp86-backup-');
  temps.push(dir);
  return dir;
}

const at = (minute: number) => () => new Date(Date.UTC(2026, 10, 17, 9, minute, 0));

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
});
