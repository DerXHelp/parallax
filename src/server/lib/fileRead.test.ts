import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import { readFileHead } from './fileRead';
import { spawnHidden, systemTool } from './process';

const windows = process.platform === 'win32';

describe('readFileHead', () => {
  it('reads up to `length` bytes from the start (fewer at the end of the file)', async () => {
    const dir = await makeTempHome('filehead-');
    const file = path.join(dir, 'a.bin');
    await writeFile(file, Buffer.from('0123456789'));
    expect((await readFileHead(file, 4)).toString()).toBe('0123');
    expect((await readFileHead(file, 100)).toString()).toBe('0123456789');
    expect((await readFileHead(file, 0)).length).toBe(0);
  });

  it('rejects unsafe paths of this host before opening anything', async () => {
    await expect(readFileHead('\\\\host\\share\\x', 4)).rejects.toBeInstanceOf(CommandError);
    await expect(readFileHead(windows ? 'C:\\x\\a.txt:ads' : '/proc/self/environ', 4)).rejects.toMatchObject({
      error: { code: 'PATH_REJECTED', params: { reason: windows ? 'ads' : 'pseudo_fs' } },
    });
    await expect(readFileHead(windows ? 'relative\\x' : 'relative/x', 4)).rejects.toMatchObject({
      error: { code: 'PATH_REJECTED', params: { reason: 'not_absolute' } },
    });
  });

  it('a missing file rejects with ENOENT', async () => {
    const dir = await makeTempHome('filehead-');
    await expect(readFileHead(path.join(dir, 'missing'), 4)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe.runIf(process.platform === 'linux')('readFileHead on Linux: regular files only (WP-103)', () => {
  const NOT_REGULAR = { error: { code: 'PATH_REJECTED', params: { reason: 'not_regular' } } };

  it('a FIFO without a writer is rejected at once – it never blocks', async () => {
    const dir = await makeTempHome('filehead-fifo-');
    const fifo = path.join(dir, 'pipe');
    const mkfifo = spawnHidden(systemTool('mkfifo'), [fifo], { stdio: 'ignore' });
    const [code] = (await once(mkfifo, 'close')) as [number | null];
    expect(code).toBe(0);
    await expect(readFileHead(fifo, 4)).rejects.toMatchObject(NOT_REGULAR);
  });

  it('a folder is rejected', async () => {
    const dir = await makeTempHome('filehead-dir-');
    await mkdir(path.join(dir, 'sub'));
    await expect(readFileHead(path.join(dir, 'sub'), 4)).rejects.toMatchObject(NOT_REGULAR);
  });
});
