import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { isTransientFsError, nodeFsOps, withFsRetry, writeFileAtomic, type FsOps } from './fs';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const fsError = (code: string): Error => Object.assign(new Error(code), { code });

describe('lib/fs (R2-10, moved from store/jsonStore.ts)', () => {
  it('only EPERM/EBUSY/EACCES are transient', () => {
    expect(['EPERM', 'EBUSY', 'EACCES'].map((code) => isTransientFsError(fsError(code)))).toEqual([
      true,
      true,
      true,
    ]);
    expect(isTransientFsError(fsError('ENOENT'))).toBe(false);
    expect(isTransientFsError(new Error('plain'))).toBe(false);
  });

  it('withFsRetry retries transient failures and rethrows the rest at once', async () => {
    let calls = 0;
    await expect(
      withFsRetry(() => {
        calls += 1;
        return calls < 3 ? Promise.reject(fsError('EBUSY')) : Promise.resolve('ok');
      }, [1, 1, 1]),
    ).resolves.toBe('ok');
    expect(calls).toBe(3);
    let enoent = 0;
    await expect(
      withFsRetry(() => {
        enoent += 1;
        return Promise.reject(fsError('ENOENT'));
      }, [1, 1]),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(enoent).toBe(1);
  });

  it('writeFileAtomic replaces the file, keeps a .bak on request and removes its temp file on failure', async () => {
    const dir = await makeTempHome('r2-libfs-');
    dirs.push(dir);
    const file = path.join(dir, 'sub', 'data.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two', { backup: true });
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readFile(`${file}.bak`, 'utf8')).toBe('one');
    const failing: FsOps = { ...nodeFsOps, rename: () => Promise.reject(fsError('EPERM')) };
    await expect(writeFileAtomic(file, 'three', { fs: failing, retryDelaysMs: [1] })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(await readFile(file, 'utf8')).toBe('two');
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
