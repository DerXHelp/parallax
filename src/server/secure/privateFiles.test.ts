import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { nodeFsOps } from '../lib/fs';
import { checkPrivateFile, narrowPrivateDir, privateFsOps, secureFsOps } from './privateFiles';

const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('private files (WP-107, §B.14)', () => {
  it('Windows keeps the default file operations', () => {
    expect(secureFsOps('win32')).toBe(nodeFsOps);
    expect(secureFsOps('linux')).toBe(privateFsOps);
  });

  posixOnly('new files 0600 in folders 0700 – also over a wider existing file', async () => {
    const home = await makeTempHome('wp107-private-');
    const dir = path.join(home, 'keys');
    await privateFsOps.mkdir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const file = path.join(dir, 'identity.json');
    await writeFile(file, 'old', { mode: 0o644 });
    await privateFsOps.writeFile(file, 'new');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await checkPrivateFile(file)).toBeNull();
  });

  posixOnly(
    'the check refuses group/other bits on the file and on its folder, and a foreign owner',
    async () => {
      const home = await makeTempHome('wp107-private-');
      const dir = path.join(home, 'keys');
      await mkdir(dir, { mode: 0o700 });
      const file = path.join(dir, 'identity.json');
      await writeFile(file, '{}', { mode: 0o600 });
      await chmod(file, 0o640);
      expect(await checkPrivateFile(file)).toBe('mode');
      await chmod(file, 0o600);
      await chmod(dir, 0o750);
      expect(await checkPrivateFile(file)).toBe('dir_mode');
      await narrowPrivateDir(dir);
      expect(await checkPrivateFile(file)).toBeNull();
      expect(await checkPrivateFile(file, { uid: 4242 })).toBe('owner');
      expect(await checkPrivateFile(path.join(dir, 'missing.json'))).toBeNull();
      expect(await checkPrivateFile(dir)).toBe('not_file');
    },
  );
});
