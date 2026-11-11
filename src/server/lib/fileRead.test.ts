import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import { readFileHead } from './fileRead';

describe('readFileHead', () => {
  it('reads up to `length` bytes from the start (fewer at the end of the file)', async () => {
    const dir = await makeTempHome('filehead-');
    const file = path.join(dir, 'a.bin');
    await writeFile(file, Buffer.from('0123456789'));
    expect((await readFileHead(file, 4)).toString()).toBe('0123');
    expect((await readFileHead(file, 100)).toString()).toBe('0123456789');
    expect((await readFileHead(file, 0)).length).toBe(0);
  });

  it('rejects unsafe paths before opening anything', async () => {
    await expect(readFileHead('\\\\host\\share\\x', 4)).rejects.toBeInstanceOf(CommandError);
    await expect(readFileHead('C:\\x\\a.txt:ads', 4)).rejects.toMatchObject({
      error: { code: 'PATH_REJECTED', params: { reason: 'ads' } },
    });
  });

  it('a missing file rejects with ENOENT', async () => {
    const dir = await makeTempHome('filehead-');
    await expect(readFileHead(path.join(dir, 'missing'), 4)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
