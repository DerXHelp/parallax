import { once } from 'node:events';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import { readFileHead } from './fileRead';
import { spawnHidden, systemTool } from './process';

const windows = process.platform === 'win32';
const LINK_TARGET = { error: { code: 'PATH_REJECTED', params: { reason: 'link_target' } } };

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

  it('physical: the open file must be the checked path – a link on the way is refused (follow-up WP-109)', async () => {
    const dir = await realpath(await makeTempHome('filehead-swap-'));
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'data');
    expect((await readFileHead(file, 4, { physical: true })).toString()).toBe('data');
    // Stands for a link swapped in after the check: the path leads elsewhere.
    const link = path.join(dir, 'swapped');
    await symlink(file, link);
    await expect(readFileHead(link, 4, { physical: true })).rejects.toMatchObject(LINK_TARGET);
    // Without `physical` (callers that check nothing else) links are followed as before.
    expect((await readFileHead(link, 4)).toString()).toBe('data');
  });
});

describe('openRegularFile with physical paths (follow-up WP-109)', () => {
  it('Linux: refused when the kernel names another path for the open file; unknown → read', async () => {
    const dir = await makeTempHome('filehead-opened-');
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'data');
    const read = (openedPath: () => Promise<string | null>, platform: NodeJS.Platform = 'linux') =>
      readFileHead(file, 4, { physical: true, platform, openedPath });
    expect((await read(() => Promise.resolve(file))).toString()).toBe('data');
    await expect(read(() => Promise.resolve('/proc/1/environ'))).rejects.toMatchObject(LINK_TARGET);
    expect((await read(() => Promise.resolve(null))).toString()).toBe('data');
    // Windows has no such check (and no /proc).
    if (windows) expect((await read(() => Promise.resolve('elsewhere'), 'win32')).toString()).toBe('data');
  });
});
