import { mkdir, readdir, readFile, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SAMPLE_TIME, sampleId } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { nodeFsOps, type FsOps } from '../lib/fs';
import {
  BACKUP_MANIFEST,
  BACKUP_NEWER_DIR,
  BACKUPS_DIR,
  BACKUPS_KEPT,
  BackupError,
  backupManifestSchema,
  createBackup,
  findBackup,
  LAST_VERSION_FILE,
  listBackups,
  pruneBackups,
  readLastBuildId,
  restoreBackup,
  writeLastBuildId,
} from './backup';
import { ENTRIES_DIR } from './decisions';
import { STORE_SCHEMAS } from './schemas';

const NOW = new Date(SAMPLE_TIME); // 2026-10-15T08:00:00.000Z
const E1 = sampleId('en', 1);
const E2 = sampleId('en', 2);
const E3 = sampleId('en', 3);
const T1 = `${ENTRIES_DIR}/${E1}/${sampleId('cv', 1)}.transcript.jsonl`;
const T2 = `${ENTRIES_DIR}/${E1}/${sampleId('cv', 2)}.transcript.jsonl`;
const T3 = `${ENTRIES_DIR}/${E2}/${sampleId('cv', 3)}.transcript.jsonl`;
const T4 = `${ENTRIES_DIR}/${E2}/${sampleId('cv', 4)}.transcript.jsonl`;
const FROM = '1.0.0+aaaaaaa';
const TO = '1.1.0+bbbbbbb.dirty-0123abcd';
const NO_RETRY: readonly number[] = [];

function abs(base: string, rel: string): string {
  return path.join(base, ...rel.split('/'));
}

async function put(base: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs(base, rel)), { recursive: true });
  await writeFile(abs(base, rel), content);
}

async function text(base: string, rel: string): Promise<string> {
  return readFile(abs(base, rel), 'utf8');
}

/** Every file below `dir` → content (relative `/`-paths). */
async function snapshot(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) Object.assign(out, await snapshot(path.join(dir, item.name), rel));
    else out[rel] = await readFile(path.join(dir, item.name), 'utf8');
  }
  return out;
}

/** The saved store files of `seedHome` (sorted like the backup). */
const SAVED_FILES = [
  `${ENTRIES_DIR}/${E1}/commands.json`,
  `${ENTRIES_DIR}/${E1}/decisions.json`,
  `${ENTRIES_DIR}/${E1}/decisions.json.bak`,
  `${ENTRIES_DIR}/${E1}/files.json`,
  `${ENTRIES_DIR}/${E2}/decisions.json`,
  'sessions.json',
  'sessions.json.bak',
  'settings.json',
];

/** A home with stores, `.bak`, transcripts and everything that must NOT be saved. */
async function seedHome(): Promise<string> {
  const home = await makeTempHome('backup-');
  for (const rel of SAVED_FILES) await put(home, rel, `old ${rel}`);
  await put(home, T1, 'line1\n'); // 6 bytes
  await put(home, T3, '0123456789'); // 10 bytes
  await put(home, T4, 'abc'); // 3 bytes
  // Never part of a backup:
  await put(home, 'processes.json', 'old processes');
  await put(home, 'processes.json.bak', 'old processes bak');
  await put(home, 'auth-secret.json', 'old secret');
  await put(home, LAST_VERSION_FILE, '{}');
  await put(home, 'sessions.json.corrupt-20261015T080000000Z-abcdef', 'corrupt');
  await put(home, 'sessions.json.123.1.tmp', 'tmp');
  await put(home, `${ENTRIES_DIR}/${E1}/plans/v1.md`, 'plan');
  await put(home, `${ENTRIES_DIR}/${E1}/attachments/0123456789abcdef/a.txt`, 'attachment');
  await put(home, 'blobs/0123', 'blob');
  await put(home, 'ui/state.json', '{}');
  await put(home, 'logs/server.log', 'log');
  return home;
}

describe('store list of the backup', () => {
  it('only backs up stores in the home or directly in entries/<id>/', () => {
    for (const store of STORE_SCHEMAS) {
      const segments = store.id.split('/');
      if (store.scope === 'entry') {
        expect([segments.length, segments[0], segments[1]], store.id).toEqual([3, ENTRIES_DIR, '*']);
      } else if (segments.length > 1) {
        // Subfolders (remote/, keys/ of several computers) are listed for the schema hash only.
        expect(store.backup, store.id).toBe(false);
      }
    }
  });
});

describe('createBackup', () => {
  it('copies the JSON stores with .bak per entry and records only the transcript lengths', async () => {
    const home = await seedHome();
    const result = await createBackup(home, { from: FROM, to: TO, now: NOW });

    expect(result.dir).toBe(path.join(home, BACKUPS_DIR, `${FROM}-zu-${TO}-20261015-080000`));
    expect(result.files).toEqual(SAVED_FILES);
    expect(result.transcripts).toEqual({ [T1]: 6, [T3]: 10, [T4]: 3 });

    const saved = await snapshot(result.dir);
    expect(Object.keys(saved).sort()).toEqual([BACKUP_MANIFEST, ...SAVED_FILES].sort());
    for (const rel of SAVED_FILES) expect(saved[rel]).toBe(`old ${rel}`);
    const manifest = backupManifestSchema.parse(JSON.parse(saved[BACKUP_MANIFEST] ?? ''));
    expect(manifest).toEqual({
      schemaVersion: 1,
      from: FROM,
      to: TO,
      createdAt: SAMPLE_TIME,
      files: SAVED_FILES,
      transcripts: result.transcripts,
    });
    // Only the finished folder is left.
    expect(await readdir(path.join(home, BACKUPS_DIR))).toEqual([path.basename(result.dir)]);
  });

  it('writes into a .partial folder first and renames it when complete', async () => {
    const home = await seedHome();
    const copies: string[] = [];
    const renames: [string, string][] = [];
    const fs: FsOps = {
      ...nodeFsOps,
      copyFile: (from, to) => {
        copies.push(to);
        return nodeFsOps.copyFile(from, to);
      },
      rename: (from, to) => {
        renames.push([from, to]);
        return nodeFsOps.rename(from, to);
      },
    };
    const result = await createBackup(home, { from: FROM, to: TO, now: NOW, fs });
    const partial = path.join(home, BACKUPS_DIR, `.partial-${path.basename(result.dir)}`);
    expect(copies).toHaveLength(SAVED_FILES.length);
    for (const target of copies) expect(target.startsWith(`${partial}${path.sep}`), target).toBe(true);
    expect(renames.at(-1)).toEqual([partial, result.dir]);
  });

  it('leaves no half backup when a run fails', async () => {
    const home = await seedHome();
    let calls = 0;
    const fs: FsOps = {
      ...nodeFsOps,
      copyFile: (from, to) => {
        calls += 1;
        if (calls === 3) return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
        return nodeFsOps.copyFile(from, to);
      },
    };
    await expect(
      createBackup(home, { from: FROM, to: TO, now: NOW, fs, retryDelaysMs: NO_RETRY }),
    ).rejects.toThrow('disk full');
    expect(await readdir(path.join(home, BACKUPS_DIR))).toEqual([]);
  });

  it('names an unknown previous build, a second backup in the same second and unsafe build ids', async () => {
    const home = await seedHome();
    const first = await createBackup(home, { from: null, to: '1.0.0', now: NOW });
    const second = await createBackup(home, { from: null, to: '1.0.0', now: NOW });
    const odd = await createBackup(home, { from: '.x:y', to: 'a/b\\c', now: NOW });
    expect(path.basename(first.dir)).toBe('unbekannt-zu-1.0.0-20261015-080000');
    expect(path.basename(second.dir)).toBe('unbekannt-zu-1.0.0-20261015-080000-2');
    expect(path.basename(odd.dir)).toBe('_.x_y-zu-a_b_c-20261015-080000');
    const manifest = backupManifestSchema.parse(JSON.parse(await text(odd.dir, BACKUP_MANIFEST)));
    expect([manifest.from, manifest.to]).toEqual(['.x:y', 'a/b\\c']);
  });

  it('works on an empty home', async () => {
    const home = await makeTempHome('backup-');
    const result = await createBackup(home, { from: FROM, to: TO, now: NOW });
    expect(result.files).toEqual([]);
    expect(result.transcripts).toEqual({});
    expect(Object.keys(await snapshot(result.dir))).toEqual([BACKUP_MANIFEST]);
  });
});

describe('restoreBackup', () => {
  /** A backup, then what a newer version did to the home. */
  async function changedAfterBackup() {
    const home = await seedHome();
    const backup = await createBackup(home, { from: FROM, to: TO, now: NOW });
    await put(home, 'sessions.json', 'new sessions'); // migrated
    await rm(abs(home, `${ENTRIES_DIR}/${E2}/decisions.json`)); // deleted
    await put(home, 'settings.json.bak', 'new settings bak'); // .bak only now
    await put(home, 'model-catalogs.json', 'new catalogs'); // store only now
    await put(home, `${ENTRIES_DIR}/${E3}/decisions.json`, 'new entry'); // entry only now
    await put(home, T1, 'line1\nline2\n'); // appended
    await put(home, T2, 'new transcript\n'); // transcript only now
    await truncate(abs(home, T3), 4); // shorter than saved
    await rm(abs(home, T4)); // missing
    await put(home, 'processes.json', 'new processes');
    await put(home, 'auth-secret.json', 'new secret');
    return { home, backup };
  }

  it('writes the files back, moves newer store files aside and cuts transcripts', async () => {
    const { home, backup } = await changedAfterBackup();
    const result = await restoreBackup(home, backup.dir);

    expect(result.restored).toEqual(SAVED_FILES);
    for (const rel of SAVED_FILES) expect(await text(home, rel)).toBe(`old ${rel}`);

    expect([...result.movedToNewer].sort()).toEqual(
      [`${ENTRIES_DIR}/${E3}/decisions.json`, T2, 'model-catalogs.json', 'settings.json.bak'].sort(),
    );
    const newer = path.join(backup.dir, BACKUP_NEWER_DIR);
    expect(await text(newer, 'model-catalogs.json')).toBe('new catalogs');
    expect(await text(newer, 'settings.json.bak')).toBe('new settings bak');
    expect(await text(newer, `${ENTRIES_DIR}/${E3}/decisions.json`)).toBe('new entry');
    expect(await text(newer, T2)).toBe('new transcript\n');
    for (const rel of result.movedToNewer) await expect(readFile(abs(home, rel))).rejects.toThrow();

    expect(result.truncated).toEqual([T1]);
    expect(await text(home, T1)).toBe('line1\n');
    expect(await text(home, T3)).toBe('0123');
    expect(result.warnings).toEqual([
      { file: T3, reason: 'shorter', savedBytes: 10, currentBytes: 4 },
      { file: T4, reason: 'missing', savedBytes: 3, currentBytes: null },
    ]);

    // Never touched, never saved.
    expect(await text(home, 'processes.json')).toBe('new processes');
    expect(await text(home, 'processes.json.bak')).toBe('old processes bak');
    expect(await text(home, 'auth-secret.json')).toBe('new secret');
    expect(await text(home, `${ENTRIES_DIR}/${E1}/plans/v1.md`)).toBe('plan');
    expect(await text(home, 'blobs/0123')).toBe('blob');
  });

  it('does not create a .bak of the replaced file', async () => {
    const home = await makeTempHome('backup-');
    await put(home, 'settings.json', 'old');
    const backup = await createBackup(home, { from: FROM, to: TO, now: NOW });
    await put(home, 'settings.json', 'new');
    await restoreBackup(home, backup.dir);
    expect((await readdir(home)).sort()).toEqual([BACKUPS_DIR, 'settings.json']);
    expect(await text(home, 'settings.json')).toBe('old');
  });

  it('keeps files of an earlier restore in newer\\', async () => {
    const home = await makeTempHome('backup-');
    await put(home, 'settings.json', 'old');
    const backup = await createBackup(home, { from: FROM, to: TO, now: NOW });
    await put(home, 'model-catalogs.json', 'first');
    await restoreBackup(home, backup.dir);
    await put(home, 'model-catalogs.json', 'second');
    await restoreBackup(home, backup.dir);
    const newer = path.join(backup.dir, BACKUP_NEWER_DIR);
    expect(await text(newer, 'model-catalogs.json')).toBe('first');
    expect(await text(newer, 'model-catalogs.json.1')).toBe('second');
  });

  describe('a broken backup changes nothing', () => {
    async function brokenWith(edit: (dir: string) => Promise<void>) {
      const { home, backup } = await changedAfterBackup();
      await edit(backup.dir);
      const before = await snapshot(home);
      await expect(restoreBackup(home, backup.dir)).rejects.toBeInstanceOf(BackupError);
      expect(await snapshot(home)).toEqual(before);
    }

    async function editManifest(dir: string, change: Record<string, unknown>) {
      const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(await text(dir, BACKUP_MANIFEST)));
      await put(dir, BACKUP_MANIFEST, JSON.stringify({ ...manifest, ...change }));
    }

    it('manifest is not JSON', async () => {
      await brokenWith((dir) => put(dir, BACKUP_MANIFEST, '{"schemaVersion": 1, "fi'));
    });

    it('manifest is missing', async () => {
      await brokenWith((dir) => rm(abs(dir, BACKUP_MANIFEST)));
    });

    it('manifest has another schema version', async () => {
      await brokenWith((dir) => editManifest(dir, { schemaVersion: 2 }));
    });

    it.each([
      ['processes.json'],
      ['auth-secret.json'],
      [`${ENTRIES_DIR}/../sessions.json`],
      ['../sessions.json'],
      [`${ENTRIES_DIR}/${E1}/plans/v1.md`],
      [T1],
      ['C:/Windows/win.ini'],
    ])('manifest lists %s as a file', async (rel) => {
      await brokenWith((dir) => editManifest(dir, { files: [rel] }));
    });

    it('manifest lists a store file as a transcript', async () => {
      await brokenWith((dir) => editManifest(dir, { transcripts: { 'sessions.json': 1 } }));
    });

    it('manifest lists a reserved device name', async () => {
      await brokenWith((dir) => editManifest(dir, { files: [`${ENTRIES_DIR}/con/decisions.json`] }));
    });

    it('a saved file is missing', async () => {
      await brokenWith((dir) => rm(abs(dir, 'settings.json')));
    });
  });
});

describe('pruneBackups', () => {
  const HOUR = 60 * 60 * 1000;

  it('keeps the three newest, unreadable ones count as oldest, stale partial folders go', async () => {
    const home = await makeTempHome('backup-');
    await put(home, 'settings.json', 'x');
    const made: string[] = [];
    // Created out of order: the age comes from backup.json, not from the name or the order.
    for (const minutes of [30, 10, 50, 20, 40]) {
      const now = new Date(NOW.getTime() + minutes * 60_000);
      made.push((await createBackup(home, { from: FROM, to: TO, now })).dir);
    }
    const root = path.join(home, BACKUPS_DIR);
    const unreadable = path.join(root, 'zzz-no-manifest');
    await put(unreadable, 'settings.json', 'x');
    const end = new Date(NOW.getTime() + 2 * HOUR);
    const stale = path.join(root, '.partial-stale');
    const fresh = path.join(root, '.partial-fresh');
    await put(stale, 'settings.json', 'x');
    await put(fresh, 'settings.json', 'x');
    await utimes(stale, new Date(end.getTime() - 2 * HOUR), new Date(end.getTime() - 2 * HOUR));
    await utimes(fresh, new Date(end.getTime() - HOUR / 6), new Date(end.getTime() - HOUR / 6));

    const deleted = await pruneBackups(home, BACKUPS_KEPT, { now: end });

    const [m30, m10, m50, m20, m40] = made;
    expect([...deleted].sort()).toEqual([stale, unreadable, m10, m20].sort());
    expect((await readdir(root)).sort()).toEqual(
      ['.partial-fresh', ...[m30, m50, m40].map((dir) => path.basename(dir ?? ''))].sort(),
    );
  });

  it('deletes an unreadable backup before a readable one', async () => {
    const home = await makeTempHome('backup-');
    const kept = await createBackup(home, { from: FROM, to: TO, now: NOW });
    const unreadable = path.join(home, BACKUPS_DIR, 'broken');
    await put(unreadable, BACKUP_MANIFEST, 'not json');
    expect(await pruneBackups(home, 1, { now: NOW })).toEqual([unreadable]);
    expect(await readdir(path.join(home, BACKUPS_DIR))).toEqual([path.basename(kept.dir)]);
  });

  it('does nothing without a backups folder', async () => {
    const home = await makeTempHome('backup-');
    expect(await pruneBackups(home)).toEqual([]);
  });
});

describe('listBackups and findBackup (WP-87)', () => {
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

  it('lists finished backups newest first and skips partial and unreadable ones', async () => {
    const home = await makeTempHome('backup-');
    expect(await listBackups(home)).toEqual([]);
    await put(home, 'settings.json', 'x');
    const first = await createBackup(home, { from: FROM, to: TO, now: at(10) });
    const third = await createBackup(home, { from: TO, to: FROM, now: at(30) });
    const second = await createBackup(home, { from: null, to: FROM, now: at(20) });
    const sameSecond = await createBackup(home, { from: TO, to: FROM, now: at(30) });
    const root = path.join(home, BACKUPS_DIR);
    await put(root, '.partial-x/settings.json', 'x');
    await put(root, `zzz-broken/${BACKUP_MANIFEST}`, 'not json');
    await put(root, 'zzz-empty/settings.json', 'x');

    const list = await listBackups(home);
    expect(list.map((backup) => backup.dir)).toEqual([sameSecond.dir, third.dir, second.dir, first.dir]);
    expect(list[0]).toMatchObject({
      name: path.basename(sameSecond.dir),
      manifest: { from: TO, to: FROM, createdAt: at(30).toISOString(), files: ['settings.json'] },
    });
  });

  it('finds the newest backup of exactly this build change', async () => {
    const home = await makeTempHome('backup-');
    await put(home, 'settings.json', 'x');
    await createBackup(home, { from: FROM, to: TO, now: at(10) });
    const newest = await createBackup(home, { from: FROM, to: TO, now: at(40) });
    const back = await createBackup(home, { from: TO, to: FROM, now: at(50) });
    const first = await createBackup(home, { from: null, to: FROM, now: at(5) });

    expect((await findBackup(home, { from: FROM, to: TO }))?.dir).toBe(newest.dir);
    expect((await findBackup(home, { from: TO, to: FROM }))?.dir).toBe(back.dir);
    expect((await findBackup(home, { from: null, to: FROM }))?.manifest.createdAt).toBe(at(5).toISOString());
    expect((await findBackup(home, { from: null, to: FROM }))?.dir).toBe(first.dir);
    expect(await findBackup(home, { from: null, to: TO })).toBeNull();
    expect(await findBackup(home, { from: FROM.toUpperCase(), to: TO })).toBeNull();
    expect(await findBackup(home, { from: FROM, to: `${TO}x` })).toBeNull();
  });
});

describe('last-version.json', () => {
  it('is null when missing or broken', async () => {
    const home = await makeTempHome('backup-');
    expect(await readLastBuildId(home)).toBeNull();
    await put(home, LAST_VERSION_FILE, '{"schemaVersion": 1, "build');
    expect(await readLastBuildId(home)).toBeNull();
    await put(home, LAST_VERSION_FILE, JSON.stringify({ schemaVersion: 2, buildId: FROM, at: SAMPLE_TIME }));
    expect(await readLastBuildId(home)).toBeNull();
    await put(home, LAST_VERSION_FILE, JSON.stringify({ schemaVersion: 1, buildId: '', at: SAMPLE_TIME }));
    expect(await readLastBuildId(home)).toBeNull();
  });

  it('round-trips the build id and writes atomically', async () => {
    const home = await makeTempHome('backup-');
    await writeLastBuildId(home, FROM, NOW);
    await writeLastBuildId(home, TO, NOW);
    expect(await readLastBuildId(home)).toBe(TO);
    expect(JSON.parse(await text(home, LAST_VERSION_FILE))).toEqual({
      schemaVersion: 1,
      buildId: TO,
      at: SAMPLE_TIME,
    });
    expect(await readdir(home)).toEqual([LAST_VERSION_FILE]);
  });
});
