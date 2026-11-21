import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { spawnHidden, systemTool } from '../lib/process';
import { readWholeFile } from './fileFs';

describe('readWholeFile (CR3-05)', () => {
  it('reads the whole file through one handle; more than max bytes → null; an empty file → empty', async () => {
    const dir = await makeTempHome('file-fs-');
    const file = path.join(dir, 'shot.png');
    const data = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));
    await writeFile(file, data);
    expect((await readWholeFile(file, data.length))?.equals(data)).toBe(true);
    expect(await readWholeFile(file, data.length - 1)).toBeNull();
    const empty = path.join(dir, 'empty.svg');
    await writeFile(empty, '');
    expect((await readWholeFile(empty, 10))?.length).toBe(0);
  });

  it('never opens an unsafe path', async () => {
    await expect(readWholeFile('\\\\host\\share\\x.png', 10)).rejects.toThrow();
  });
});

describe.runIf(process.platform === 'linux')(
  'readWholeFile on Linux: regular files only (review WP-109)',
  () => {
    it('a FIFO swapped in after the head was read is rejected at once – it never blocks', async () => {
      const dir = await makeTempHome('file-fs-fifo-');
      const fifo = path.join(dir, 'x.png');
      const mkfifo = spawnHidden(systemTool('mkfifo'), [fifo], { stdio: 'ignore' });
      const [code] = (await once(mkfifo, 'close')) as [number | null];
      expect(code).toBe(0);
      await expect(readWholeFile(fifo, 1024)).rejects.toMatchObject({
        error: { code: 'PATH_REJECTED', params: { reason: 'not_regular' } },
      });
    });
  },
);
