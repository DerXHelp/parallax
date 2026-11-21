import { mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { fsListingSchema, type FsListing } from '@shared/model';
import { POSIX_PATHS } from '@shared/paths';
import { SAMPLE_IDS } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import {
  DRIVE_PROBE_LIMIT,
  childPath,
  createFsCommands,
  isHiddenName,
  nodeDirFs,
  parentPath,
  type DirEntry,
  type DirFs,
} from './fsCommands';

const CTX = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };
/** Tests on the real file system of this host: Windows-only and POSIX-only cases (WP-103). */
const WIN = process.platform === 'win32';

async function listing(
  handler: ReturnType<typeof createFsCommands>,
  dir: string | null,
  showHidden = false,
): Promise<FsListing> {
  return fsListingSchema.parse(
    await handler.handle({ name: 'fs.listDirectory', path: dir, showHidden }, CTX),
  );
}

async function rejection(promise: Promise<unknown>): Promise<ErrorPayload | null> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommandError) return error.error;
    throw error;
  }
  return null;
}

const errno = (code: string): Error => Object.assign(new Error(code), { code });

const dirent = (name: string, kind: 'dir' | 'file' | 'link'): DirEntry => ({
  name,
  isDirectory: () => kind === 'dir',
  isSymbolicLink: () => kind === 'link',
});

/**
 * The real fs plus fake entries: `extra` adds directory entries of `dir` (e.g. a symlink to
 * `\\server\share`, which needs admin rights for real); `links` answers readlink/lstat for them.
 * `touched` records every stat/readlink of a fake entry – unsafe ones must never be followed.
 */
function layered(
  dir: string,
  extra: DirEntry[],
  links: Record<string, string>,
): DirFs & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    lstat: (p) => (p in links ? Promise.resolve({ isSymbolicLink: () => true }) : nodeDirFs.lstat(p)),
    readlink: (p) => {
      const target = links[p];
      if (target === undefined) return nodeDirFs.readlink(p);
      touched.push(`readlink ${p}`);
      return Promise.resolve(target);
    },
    stat: (p) => {
      if (p in links) touched.push(`stat ${p}`);
      return nodeDirFs.stat(p);
    },
    readdir: async (p) => [...(await nodeDirFs.readdir(p)), ...(p === dir ? extra : [])],
  };
}

async function tree(): Promise<string> {
  const root = await makeTempHome('fs-list-');
  for (const name of ['alpha', 'Beta', 'gamma', '.git', '$Recycle.Bin', 'System Volume Information']) {
    await mkdir(path.join(root, name));
  }
  await writeFile(path.join(root, 'file.txt'), 'x', 'utf8');
  await symlink(path.join(root, 'gamma'), path.join(root, 'junction'), 'junction');
  const gone = path.join(root, 'gone');
  await mkdir(gone);
  await symlink(gone, path.join(root, 'dangling'), 'junction');
  await rm(gone, { recursive: true });
  return root;
}

describe('fs.listDirectory: a folder (ADR-119)', () => {
  it.runIf(WIN)(
    'lists folders and junctions to folders, sorted case-insensitively, paths = input + name',
    async () => {
      const root = await tree();
      const result = await listing(createFsCommands(), root);
      expect(result).toEqual({
        path: root,
        parent: path.dirname(root),
        entries: [
          { name: 'alpha', path: `${root}\\alpha`, kind: 'directory', hidden: false },
          { name: 'Beta', path: `${root}\\Beta`, kind: 'directory', hidden: false },
          { name: 'gamma', path: `${root}\\gamma`, kind: 'directory', hidden: false },
          { name: 'junction', path: `${root}\\junction`, kind: 'link', hidden: false },
        ],
        truncated: false,
      });
    },
  );

  it.runIf(WIN)('showHidden adds dot folders and system folders, marked hidden', async () => {
    const root = await tree();
    const names = (await listing(createFsCommands(), root, true)).entries
      .filter((e) => e.hidden)
      .map((e) => e.name);
    expect(names).toEqual(['$Recycle.Bin', '.git', 'System Volume Information']);
  });

  it('hidden names: dot names everywhere, the Explorer system folders only on Windows', () => {
    expect(isHiddenName('Recovery')).toBe(true);
    expect(isHiddenName('config.msi')).toBe(true);
    expect(isHiddenName('$WinREAgent')).toBe(true);
    expect(isHiddenName('Projects')).toBe(false);
    expect(isHiddenName('.config', POSIX_PATHS)).toBe(true);
    expect(isHiddenName('Recovery', POSIX_PATHS)).toBe(false);
    expect(isHiddenName('$Recycle.Bin', POSIX_PATHS)).toBe(false);
  });

  it.runIf(WIN)('keeps the spelling of the input (trailing separator, forward slashes)', async () => {
    const root = await tree();
    const slashed = root.replace(/\\/g, '/');
    const result = await listing(createFsCommands(), slashed);
    expect(result.path).toBe(slashed);
    expect(result.entries[0]?.path).toBe(`${slashed}/alpha`);
    expect((await listing(createFsCommands(), `${root}\\`)).entries[0]?.path).toBe(`${root}\\alpha`);
  });

  it.runIf(WIN)('R1-17: a symlink to \\\\server\\share is left out and never followed', async () => {
    const root = await tree();
    const share = `${root}\\share`;
    const fs = layered(root, [dirent('share', 'link')], { [share]: '\\\\server\\share' });
    const result = await listing(createFsCommands({ fs }), root);
    expect(result.entries.map((e) => e.name)).not.toContain('share');
    expect(fs.touched).toEqual([`readlink ${share}`]);
  });

  it.runIf(WIN)('R1-17: listing a path through a link to a share is PATH_REJECTED link_target', async () => {
    const root = await tree();
    const share = `${root}\\share`;
    const fs = layered(root, [], { [share]: '\\\\server\\share' });
    expect(await rejection(listing(createFsCommands({ fs }), `${share}\\sub`))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'link_target' },
    });
    expect(fs.touched).toEqual([`readlink ${share}`]);
  });

  it.runIf(WIN)('error codes: missing, file, unsafe string, no permission', async () => {
    const root = await tree();
    const handler = createFsCommands();
    expect(await rejection(listing(handler, `${root}\\missing`))).toEqual({
      code: 'CWD_NOT_FOUND',
      params: {},
    });
    expect(await rejection(listing(handler, `${root}\\file.txt`))).toEqual({
      code: 'CWD_NOT_DIRECTORY',
      params: {},
    });
    expect(await rejection(listing(handler, '\\\\server\\share'))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'unc' },
    });
    expect(await rejection(listing(handler, 'relative\\x'))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'not_absolute' },
    });
    const denied: DirFs = { ...nodeDirFs, readdir: () => Promise.reject(errno('EPERM')) };
    expect(await rejection(listing(createFsCommands({ fs: denied }), root))).toEqual({
      code: 'FOLDER_NOT_READABLE',
      params: { path: root },
    });
    const noAccess: DirFs = { ...nodeDirFs, stat: () => Promise.reject(errno('EACCES')) };
    expect(await rejection(listing(createFsCommands({ fs: noAccess }), root))).toEqual({
      code: 'FOLDER_NOT_READABLE',
      params: { path: root },
    });
  });

  it(`more than LIMITS.fsListMax (${String(LIMITS.fsListMax)}) folders → truncated, the first ones kept`, async () => {
    const many = Array.from({ length: LIMITS.fsListMax + 5 }, (_, i) =>
      dirent(`d${String(i).padStart(5, '0')}`, 'dir'),
    );
    const fs: DirFs = {
      lstat: () => Promise.resolve({ isSymbolicLink: () => false }),
      readlink: () => Promise.reject(errno('EINVAL')),
      stat: () => Promise.resolve({ isDirectory: () => true }),
      readdir: () => Promise.resolve([...many].reverse()),
    };
    const result = await listing(createFsCommands({ fs, platform: 'win32' }), 'D:\\big');
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(LIMITS.fsListMax);
    expect(result.entries[0]?.name).toBe('d00000');
    expect(result.parent).toBe('D:\\');
  });
});

describe('fs.listDirectory: roots (path null)', () => {
  /** Fake drives: `answers` per root (`dir`, `missing`, `hang`); counts the stats per root. */
  function drives(
    answers: Record<string, 'dir' | 'missing' | 'hang'>,
  ): DirFs & { stats: Map<string, number> } {
    const stats = new Map<string, number>();
    return {
      stats,
      lstat: () => Promise.resolve({ isSymbolicLink: () => false }),
      readlink: () => Promise.reject(errno('EINVAL')),
      readdir: () => Promise.resolve([]),
      stat: (p) => {
        stats.set(p, (stats.get(p) ?? 0) + 1);
        const answer = answers[p] ?? 'missing';
        if (answer === 'hang') return new Promise(() => undefined);
        return answer === 'dir'
          ? Promise.resolve({ isDirectory: () => true })
          : Promise.reject(errno('ENOENT'));
      },
    };
  }

  it('the user folder and the answering drives; slow and missing drives are skipped', async () => {
    const fs = drives({ 'C:\\': 'dir', 'D:\\': 'hang', 'Z:\\': 'dir' });
    const handler = createFsCommands({ fs, home: 'C:\\Users\\u', platform: 'win32', driveTimeoutMs: 50 });
    expect(await listing(handler, null)).toEqual({
      path: null,
      parent: null,
      entries: [
        { name: 'u', path: 'C:\\Users\\u', kind: 'home', hidden: false },
        { name: 'C:', path: 'C:\\', kind: 'drive', hidden: false },
        { name: 'Z:', path: 'Z:\\', kind: 'drive', hidden: false },
      ],
      truncated: false,
    });
    expect(fs.stats.size).toBe(26);
    // R8: the hanging drive gets no second stat while the first one still hangs.
    await listing(handler, null);
    expect(fs.stats.get('D:\\')).toBe(1);
    expect(fs.stats.get('C:\\')).toBe(2);
  });

  it('CR2-06: at most DRIVE_PROBE_LIMIT drive stats at once – given-up (still hanging) ones count, across listings', async () => {
    // D: and E: hang like disconnected network drives until released; the others answer at once.
    const hung = new Map<string, () => void>();
    let inFlight = 0;
    let maxInFlight = 0;
    const stats: string[] = [];
    const fs: DirFs = {
      lstat: () => Promise.resolve({ isSymbolicLink: () => false }),
      readlink: () => Promise.reject(errno('EINVAL')),
      readdir: () => Promise.resolve([]),
      stat: (p) => {
        stats.push(p);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const settle = <T>(value: Promise<T>) =>
          value.finally(() => {
            inFlight -= 1;
          });
        if (p === 'D:\\' || p === 'E:\\') {
          return settle(
            new Promise((_resolve, reject) => {
              hung.set(p, () => {
                reject(errno('ETIMEDOUT'));
              });
            }),
          );
        }
        if (p === 'C:\\' || p === 'Z:\\') return settle(Promise.resolve({ isDirectory: () => true }));
        return settle(Promise.reject(errno('ENOENT')));
      },
    };
    const handler = createFsCommands({ fs, home: 'C:\\Users\\u', platform: 'win32', driveTimeoutMs: 50 });
    const drivesOf = async () =>
      (await listing(handler, null)).entries.filter((e) => e.kind === 'drive').map((e) => e.name);
    const first = await drivesOf();
    // Never all 26 at once (libuv has 4 threads; two stay free for the rest of the server).
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(DRIVE_PROBE_LIMIT).toBe(2);
    // C: answers before the hanging drives take both slots; the drives behind them wait.
    expect(first).toEqual(['C:']);
    // A second listing while D:/E: still hang starts no further stat beyond the limit; C: waits
    // behind them and keeps its last answer (a local drive does not vanish), D: gets no second stat.
    expect(await drivesOf()).toEqual(['C:']);
    expect(maxInFlight).toBeLessThanOrEqual(DRIVE_PROBE_LIMIT);
    expect(stats.filter((p) => p === 'D:\\')).toHaveLength(1);
    expect(stats.filter((p) => p === 'C:\\')).toHaveLength(1);
    // Once the hanging stats end, the waiting probes run (still within the limit) and Z: is back.
    for (const release of hung.values()) release();
    await vi.waitFor(() => {
      expect(stats).toContain('Z:\\');
    });
    await vi.waitFor(async () => {
      expect(await drivesOf()).toEqual(['C:', 'Z:']);
    });
    expect(maxInFlight).toBeLessThanOrEqual(DRIVE_PROBE_LIMIT);
  });

  it('POSIX (WP-103): the user folder, / and the answering /media/<user> and /mnt; no drives', async () => {
    const fs = drives({ 'C:\\': 'dir', '/mnt': 'dir', '/media/u': 'hang' });
    const handler = createFsCommands({
      fs,
      home: '/home/u',
      platform: 'linux',
      userName: 'u',
      driveTimeoutMs: 50,
    });
    expect((await listing(handler, null)).entries).toEqual([
      { name: 'u', path: '/home/u', kind: 'home', hidden: false },
      { name: '/', path: '/', kind: 'drive', hidden: false },
      { name: '/mnt', path: '/mnt', kind: 'drive', hidden: false },
    ]);
    expect([...fs.stats.keys()].sort()).toEqual(['/media/u', '/mnt']);
    // A Windows user folder is no POSIX path; a user name that is no file name adds no /media root.
    const odd = createFsCommands({ fs, home: 'C:\\Users\\u', platform: 'linux', userName: '../x' });
    expect((await listing(odd, null)).entries.map((e) => e.path)).toEqual(['/', '/mnt']);
  });

  it('an unsafe user folder (roaming share) is left out', async () => {
    const fs = drives({ 'C:\\': 'dir' });
    const roaming = createFsCommands({
      fs,
      home: '\\\\server\\profiles\\u',
      platform: 'win32',
      driveTimeoutMs: 50,
    });
    expect((await listing(roaming, null)).entries.map((e) => e.kind)).toEqual(['drive']);
  });

  it('answers only fs.listDirectory and fs.createDirectory', () => {
    expect(createFsCommands().names).toEqual(['fs.listDirectory', 'fs.createDirectory']);
  });
});

describe('fs.createDirectory (WP-94)', () => {
  const create = (handler: ReturnType<typeof createFsCommands>, parent: string, folderName: string) =>
    handler.handle({ name: 'fs.createDirectory', parent, folderName }, CTX);

  it.runIf(WIN)(
    'creates one folder in the parent and answers its path in the spelling of the parent',
    async () => {
      const root = await tree();
      const handler = createFsCommands();
      expect(await create(handler, root, 'foobar')).toEqual({ path: `${root}\\foobar` });
      expect((await stat(path.join(root, 'foobar'))).isDirectory()).toBe(true);
      const slashed = root.replaceAll('\\', '/');
      expect(await create(handler, `${slashed}/`, 'Neuer Ordner')).toEqual({
        path: `${slashed}/Neuer Ordner`,
      });
      // The new folder is listed like any other.
      expect((await listing(handler, root)).entries.map((e) => e.name)).toContain('foobar');
    },
  );

  it.runIf(WIN)('never creates more than the named folder: missing parent, file, existing name', async () => {
    const root = await tree();
    const handler = createFsCommands();
    expect(await rejection(create(handler, `${root}\\missing`, 'x'))).toEqual({
      code: 'CWD_NOT_FOUND',
      params: {},
    });
    expect(await readdir(root)).not.toContain('missing');
    expect(await rejection(create(handler, `${root}\\file.txt`, 'x'))).toEqual({
      code: 'CWD_NOT_DIRECTORY',
      params: {},
    });
    expect(await rejection(create(handler, root, 'alpha'))).toEqual({
      code: 'FOLDER_EXISTS',
      params: { path: `${root}\\alpha` },
    });
    // Case-insensitive like Windows; a file of the name counts too.
    expect((await rejection(create(handler, root, 'ALPHA')))?.code).toBe('FOLDER_EXISTS');
    expect((await rejection(create(handler, root, 'file.txt')))?.code).toBe('FOLDER_EXISTS');
  });

  it.each([
    ['a\\b', 'invalid_char'],
    ['a/b', 'invalid_char'],
    ['..', 'dot_segment'],
    ['x.', 'trailing_dot_or_space'],
    ['CON', 'reserved_name'],
    ['a:b', 'invalid_char'],
  ])('rejects the name %j (%s) before any file system call', async (folderName, reason) => {
    const made: string[] = [];
    const handler = createFsCommands({
      fs: { ...nodeDirFs, stat: () => Promise.reject(new Error('no fs call expected')) },
      platform: 'win32',
      mkdir: (dir) => {
        made.push(dir);
        return Promise.resolve();
      },
    });
    expect(await rejection(create(handler, 'D:\\work', folderName))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason },
    });
    expect(made).toEqual([]);
  });

  it('rejects an unsafe parent (R1-17)', async () => {
    const made: string[] = [];
    const mkdirSpy = (dir: string) => {
      made.push(dir);
      return Promise.resolve();
    };
    expect(
      await rejection(
        create(createFsCommands({ mkdir: mkdirSpy, platform: 'win32' }), '\\\\server\\share', 'x'),
      ),
    ).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'unc' },
    });
    expect(made).toEqual([]);
  });

  it.runIf(WIN)('rejects a parent behind a link to a share (R1-17)', async () => {
    const made: string[] = [];
    const mkdirSpy = (dir: string) => {
      made.push(dir);
      return Promise.resolve();
    };
    const root = await tree();
    const share = `${root}\\share`;
    const fs = layered(root, [], { [share]: '\\\\server\\share' });
    expect(await rejection(create(createFsCommands({ fs, mkdir: mkdirSpy }), `${share}\\sub`, 'x'))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'link_target' },
    });
    expect(made).toEqual([]);
  });

  it(`a new path longer than LIMITS.pathChars (${String(LIMITS.pathChars)}) is rejected before mkdir`, async () => {
    const made: string[] = [];
    const handler = createFsCommands({
      platform: 'win32',
      mkdir: (dir) => {
        made.push(dir);
        return Promise.resolve();
      },
    });
    const parent = `D:\\${'p'.repeat(LIMITS.pathChars - 10)}`;
    expect(await rejection(create(handler, parent, 'x'.repeat(20)))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'too_long' },
    });
    expect(made).toEqual([]);
  });

  it('no permission → FOLDER_NOT_WRITABLE with the parent', async () => {
    const root = await tree();
    for (const code of ['EPERM', 'EACCES', 'EROFS']) {
      const handler = createFsCommands({ mkdir: () => Promise.reject(errno(code)) });
      expect(await rejection(create(handler, root, 'x'))).toEqual({
        code: 'FOLDER_NOT_WRITABLE',
        params: { path: root },
      });
    }
  });
});

describe('path helpers', () => {
  it('parentPath: null at a drive root', () => {
    expect(parentPath('D:\\')).toBeNull();
    expect(parentPath('D:/')).toBeNull();
    expect(parentPath('D:\\work')).toBe('D:\\');
    expect(parentPath('D:\\work\\x\\')).toBe('D:\\work');
    expect(parentPath('D:/work/x')).toBe('D:/work');
  });

  it('childPath: one separator, the input kept', () => {
    expect(childPath('D:\\', 'x')).toBe('D:\\x');
    expect(childPath('D:\\work', 'x')).toBe('D:\\work\\x');
    expect(childPath('D:/work', 'x')).toBe('D:/work/x');
    expect(childPath('D:/work\\a', 'x')).toBe('D:/work\\a\\x');
  });
});

describe('POSIX hosts (WP-103)', () => {
  it('path helpers: / separators, parent null at /', () => {
    expect(parentPath('/', POSIX_PATHS)).toBeNull();
    expect(parentPath('/home', POSIX_PATHS)).toBe('/');
    expect(parentPath('/home/u/', POSIX_PATHS)).toBe('/home');
    expect(childPath('/', 'home', POSIX_PATHS)).toBe('/home');
    expect(childPath('/home/u', 'x', POSIX_PATHS)).toBe('/home/u/x');
    expect(childPath('/home/u/', 'a:b', POSIX_PATHS)).toBe('/home/u/a:b');
  });

  it.each([
    ['a/b', 'invalid_char'],
    ['..', 'dot_segment'],
    ['.', 'dot_segment'],
  ])('rejects the name %j (%s) before any file system call', async (folderName, reason) => {
    const made: string[] = [];
    const handler = createFsCommands({
      fs: { ...nodeDirFs, stat: () => Promise.reject(new Error('no fs call expected')) },
      platform: 'linux',
      mkdir: (dir) => {
        made.push(dir);
        return Promise.resolve();
      },
    });
    expect(
      await rejection(handler.handle({ name: 'fs.createDirectory', parent: '/srv', folderName }, CTX)),
    ).toEqual({
      code: 'PATH_REJECTED',
      params: { reason },
    });
    expect(made).toEqual([]);
  });

  it('a Windows path, a relative path and /proc are refused before any file system call', async () => {
    const handler = createFsCommands({
      fs: { ...nodeDirFs, stat: () => Promise.reject(new Error('no fs call expected')) },
      platform: 'linux',
    });
    for (const [dir, reason] of [
      ['D:\\work', 'not_absolute'],
      ['relative/x', 'not_absolute'],
      ['/proc/self', 'pseudo_fs'],
      ['/home/u/../x', 'dot_segment'],
    ] as const) {
      expect(await rejection(listing(handler, dir))).toEqual({ code: 'PATH_REJECTED', params: { reason } });
    }
  });
});

describe.runIf(!WIN)('POSIX hosts on the real file system (WP-103)', () => {
  async function posixTree(): Promise<string> {
    const root = await makeTempHome('fs-list-posix-');
    for (const name of ['alpha', 'Beta', 'gamma', '.git', '$Recycle.Bin']) {
      await mkdir(path.join(root, name));
    }
    await writeFile(path.join(root, 'file.txt'), 'x', 'utf8');
    await symlink(path.join(root, 'gamma'), path.join(root, 'link'));
    await symlink('/proc/self', path.join(root, 'proc-link'));
    await symlink('missing-target', path.join(root, 'dangling'));
    return root;
  }

  it('lists folders and links to folders (case-insensitive order), dot names hidden only, / separators', async () => {
    const root = await posixTree();
    const result = await listing(createFsCommands(), root);
    expect(result).toEqual({
      path: root,
      parent: path.dirname(root),
      entries: [
        { name: '$Recycle.Bin', path: `${root}/$Recycle.Bin`, kind: 'directory', hidden: false },
        { name: 'alpha', path: `${root}/alpha`, kind: 'directory', hidden: false },
        { name: 'Beta', path: `${root}/Beta`, kind: 'directory', hidden: false },
        { name: 'gamma', path: `${root}/gamma`, kind: 'directory', hidden: false },
        { name: 'link', path: `${root}/link`, kind: 'link', hidden: false },
      ],
      truncated: false,
    });
    expect((await listing(createFsCommands(), `${root}/`)).entries[0]?.path).toBe(`${root}/$Recycle.Bin`);
    const hidden = (await listing(createFsCommands(), root, true)).entries.filter((e) => e.hidden);
    expect(hidden.map((e) => e.name)).toEqual(['.git']);
  });

  it('R1-17: a link into /proc is left out; listing through it is PATH_REJECTED link_target', async () => {
    const root = await posixTree();
    expect((await listing(createFsCommands(), root)).entries.map((e) => e.name)).not.toContain('proc-link');
    expect(await rejection(listing(createFsCommands(), `${root}/proc-link`))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'link_target' },
    });
  });

  it('error codes: missing, file', async () => {
    const root = await posixTree();
    expect(await rejection(listing(createFsCommands(), `${root}/missing`))).toEqual({
      code: 'CWD_NOT_FOUND',
      params: {},
    });
    expect(await rejection(listing(createFsCommands(), `${root}/file.txt`))).toEqual({
      code: 'CWD_NOT_DIRECTORY',
      params: {},
    });
  });

  it('creates folders case-sensitively; names Windows forbids are fine', async () => {
    const root = await posixTree();
    const handler = createFsCommands();
    const create = (folderName: string) =>
      handler.handle({ name: 'fs.createDirectory', parent: root, folderName }, CTX);
    expect(await create('ALPHA')).toEqual({ path: `${root}/ALPHA` });
    expect(await create('CON')).toEqual({ path: `${root}/CON` });
    expect(await create('a:b')).toEqual({ path: `${root}/a:b` });
    expect(await create('x.')).toEqual({ path: `${root}/x.` });
    expect((await stat(path.join(root, 'ALPHA'))).isDirectory()).toBe(true);
    expect(await rejection(create('alpha'))).toEqual({
      code: 'FOLDER_EXISTS',
      params: { path: `${root}/alpha` },
    });
  });
});
