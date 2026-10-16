import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { fsListingSchema, type FsListing } from '@shared/model';
import { SAMPLE_IDS } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import {
  childPath,
  createFsCommands,
  isHiddenName,
  nodeDirFs,
  parentPath,
  type DirEntry,
  type DirFs,
} from './fsCommands';

const CTX = { clientId: SAMPLE_IDS.client, cmdId: SAMPLE_IDS.cmdId };

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
  it('lists folders and junctions to folders, sorted case-insensitively, paths = input + name', async () => {
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
  });

  it('showHidden adds dot folders and system folders, marked hidden', async () => {
    const root = await tree();
    const names = (await listing(createFsCommands(), root, true)).entries
      .filter((e) => e.hidden)
      .map((e) => e.name);
    expect(names).toEqual(['$Recycle.Bin', '.git', 'System Volume Information']);
    expect(isHiddenName('Recovery')).toBe(true);
    expect(isHiddenName('config.msi')).toBe(true);
    expect(isHiddenName('$WinREAgent')).toBe(true);
    expect(isHiddenName('Projects')).toBe(false);
  });

  it('keeps the spelling of the input (trailing separator, forward slashes)', async () => {
    const root = await tree();
    const slashed = root.replace(/\\/g, '/');
    const result = await listing(createFsCommands(), slashed);
    expect(result.path).toBe(slashed);
    expect(result.entries[0]?.path).toBe(`${slashed}/alpha`);
    expect((await listing(createFsCommands(), `${root}\\`)).entries[0]?.path).toBe(`${root}\\alpha`);
  });

  it('R1-17: a symlink to \\\\server\\share is left out and never followed', async () => {
    const root = await tree();
    const share = `${root}\\share`;
    const fs = layered(root, [dirent('share', 'link')], { [share]: '\\\\server\\share' });
    const result = await listing(createFsCommands({ fs }), root);
    expect(result.entries.map((e) => e.name)).not.toContain('share');
    expect(fs.touched).toEqual([`readlink ${share}`]);
  });

  it('R1-17: listing a path through a link to a share is PATH_REJECTED link_target', async () => {
    const root = await tree();
    const share = `${root}\\share`;
    const fs = layered(root, [], { [share]: '\\\\server\\share' });
    expect(await rejection(listing(createFsCommands({ fs }), `${share}\\sub`))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'link_target' },
    });
    expect(fs.touched).toEqual([`readlink ${share}`]);
  });

  it('error codes: missing, file, unsafe string, no permission', async () => {
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
    const result = await listing(createFsCommands({ fs }), 'D:\\big');
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

  it('no drives off Windows; an unsafe user folder (roaming share) is left out', async () => {
    const fs = drives({ 'C:\\': 'dir' });
    expect(
      (await listing(createFsCommands({ fs, home: 'C:\\Users\\u', platform: 'linux' }), null)).entries,
    ).toEqual([{ name: 'u', path: 'C:\\Users\\u', kind: 'home', hidden: false }]);
    const roaming = createFsCommands({
      fs,
      home: '\\\\server\\profiles\\u',
      platform: 'win32',
      driveTimeoutMs: 50,
    });
    expect((await listing(roaming, null)).entries.map((e) => e.kind)).toEqual(['drive']);
  });

  it('answers only fs.listDirectory', () => {
    expect(createFsCommands().names).toEqual(['fs.listDirectory']);
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
