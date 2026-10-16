import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import {
  assertNoUnsafeLink,
  assertSafePath,
  checkCwd,
  fsErrorCode,
  resolveAllowedPath,
  resolveLinkTarget,
  type LinkFs,
} from './paths';

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

function payload(error: unknown) {
  return error instanceof CommandError ? error.error : null;
}

describe('assertSafePath', () => {
  it('accepts plain drive paths', () => {
    expect(() => {
      assertSafePath('C:\\work\\project');
    }).not.toThrow();
    expect(() => {
      assertSafePath('D:/work/project');
    }).not.toThrow();
  });

  it.each([
    ['\\\\server\\share\\x', 'unc'],
    ['//server/share', 'unc'],
    ['\\\\?\\C:\\x', 'device'],
    ['\\\\.\\pipe\\x', 'device'],
    ['C:\\x\\file.txt:stream', 'ads'],
    ['C:\\x\\NUL', 'reserved_name'],
    ['relative\\x', 'not_absolute'],
  ])('rejects %s (%s) with PATH_REJECTED', (input, reason) => {
    let thrown: unknown = null;
    try {
      assertSafePath(input);
    } catch (error) {
      thrown = error;
    }
    expect(payload(thrown)).toEqual({ code: 'PATH_REJECTED', params: { reason } });
  });
});

describe('checkCwd', () => {
  it('accepts an existing directory and keeps the string untouched', async () => {
    const dir = await makeTempHome('paths-');
    await expect(checkCwd(dir)).resolves.toBeUndefined();
  });

  it('distinguishes missing paths and files', async () => {
    const dir = await makeTempHome('paths-');
    const file = path.join(dir, 'file.txt');
    await writeFile(file, 'x', 'utf8');
    expect(payload(await errorOf(checkCwd(path.join(dir, 'missing'))))).toEqual({
      code: 'CWD_NOT_FOUND',
      params: {},
    });
    expect(payload(await errorOf(checkCwd(file)))).toEqual({ code: 'CWD_NOT_DIRECTORY', params: {} });
  });

  it('rejects UNC paths before touching the file system', async () => {
    expect(payload(await errorOf(checkCwd('\\\\attacker.example\\share')))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'unc' },
    });
  });
});

/**
 * Fake LinkFs (a symlink to `\\server\share` needs admin rights): `links` maps a path (any case)
 * to its readlink target; `missing` paths answer ENOENT; everything else is a plain folder.
 * `touched` records every call – an unsafe target must never be passed to lstat/readlink.
 */
function fakeLinks(links: Record<string, string>, missing: string[] = []): LinkFs & { touched: string[] } {
  const key = (p: string) => p.toLowerCase().replace(/\//g, '\\');
  const byKey = new Map(Object.entries(links).map(([p, t]) => [key(p), t]));
  const gone = new Set(missing.map(key));
  const touched: string[] = [];
  return {
    touched,
    lstat: (p) => {
      touched.push(p);
      if (gone.has(key(p))) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve({ isSymbolicLink: () => byKey.has(key(p)) });
    },
    readlink: (p) => {
      touched.push(p);
      const target = byKey.get(key(p));
      return target === undefined ? Promise.reject(new Error('EINVAL')) : Promise.resolve(target);
    },
  };
}

describe('assertNoUnsafeLink (R1-17: lstat/readlink per segment)', () => {
  const rejected = { code: 'PATH_REJECTED', params: { reason: 'link_target' } };

  it('accepts plain paths and links to safe drive paths (also relative and chained)', async () => {
    const fs = fakeLinks({
      'C:\\work\\a': 'D:\\real\\b',
      'D:\\real\\b': '..\\other',
      'D:\\other': 'E:\\final',
    });
    await expect(assertNoUnsafeLink('C:\\work\\a\\b\\c', fs)).resolves.toBeUndefined();
    // The drive root itself is never asked; each target is checked before going through it.
    expect(fs.touched).not.toContain('C:\\');
    expect(fs.touched).toEqual(
      expect.arrayContaining([
        'C:\\work',
        'C:\\work\\a',
        'D:\\real\\b',
        'D:\\other',
        'E:\\final',
        'C:\\work\\a\\b\\c',
      ]),
    );
  });

  it.each([
    ['a symlink to a UNC share', { 'C:\\work\\share': '\\\\server\\share' }, 'C:\\work\\share\\x'],
    ['a device target', { 'C:\\work\\dev': '\\\\?\\GLOBALROOT\\Device\\X' }, 'C:\\work\\dev'],
    ['a root-relative target', { 'C:\\work\\root': '\\Windows' }, 'C:\\work\\root'],
    ['a drive-relative target', { 'C:\\work\\rel': 'D:foo' }, 'C:\\work\\rel'],
    ['a UNC target behind a safe link', { 'C:\\a': 'D:\\b', 'D:\\b': '\\\\evil\\s' }, 'C:\\a\\x'],
    ['a loop', { 'C:\\a': 'C:\\b', 'C:\\b': 'C:\\a' }, 'C:\\a'],
  ])('rejects %s with PATH_REJECTED link_target, never touching it', async (_name, links, input) => {
    const fs = fakeLinks(links);
    expect(payload(await errorOf(assertNoUnsafeLink(input, fs)))).toEqual(rejected);
    expect(fs.touched.some((p) => p.startsWith('\\\\') || p.startsWith('//'))).toBe(false);
  });

  it('rejects unsafe strings first and stops at a missing segment', async () => {
    const fs = fakeLinks({}, ['C:\\work\\missing']);
    expect(payload(await errorOf(assertNoUnsafeLink('\\\\server\\share', fs)))).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'unc' },
    });
    expect(fs.touched).toEqual([]);
    await expect(assertNoUnsafeLink('C:\\work\\missing\\deeper', fs)).resolves.toBeUndefined();
    expect(fs.touched).toEqual(['C:\\work', 'C:\\work\\missing']);
  });

  it('a reparse point that cannot be read is rejected (fail closed)', async () => {
    const fs: LinkFs = {
      lstat: () => Promise.resolve({ isSymbolicLink: () => true }),
      readlink: () => Promise.reject(Object.assign(new Error('EINVAL'), { code: 'EINVAL' })),
    };
    expect(payload(await errorOf(assertNoUnsafeLink('C:\\cloud', fs)))).toEqual(rejected);
  });

  it('resolveLinkTarget resolves plain relative targets against the link folder only', () => {
    expect(resolveLinkTarget('C:\\a\\link', '..\\b')).toBe('C:\\b');
    expect(resolveLinkTarget('C:\\a\\link', 'sub')).toBe('C:\\a\\sub');
    expect(resolveLinkTarget('C:\\a\\link', 'D:\\x')).toBe('D:\\x');
    expect(resolveLinkTarget('C:\\a\\link', '\\\\srv\\s')).toBeNull();
    expect(resolveLinkTarget('C:\\a\\link', '//srv/s')).toBeNull();
    expect(resolveLinkTarget('C:\\a\\link', '')).toBeNull();
  });

  it('real junctions: checkCwd and resolveAllowedPath go through safe ones, reject unsafe targets', async () => {
    const root = await makeTempHome('paths-link-');
    const target = path.join(root, 'target');
    await mkdir(target);
    const junction = path.join(root, 'junction');
    await symlink(target, junction, 'junction');
    await expect(checkCwd(junction)).resolves.toBeUndefined();
    await writeFile(path.join(target, 'a.txt'), 'a', 'utf8');
    expect((await resolveAllowedPath(path.join(junction, 'a.txt'), [root])).toLowerCase()).toContain('a.txt');
    // The same paths with a fake LinkFs that reports the junction as a link to a share.
    const evil = fakeLinks({ [junction]: '\\\\server\\share' });
    expect(payload(await errorOf(checkCwd(junction, evil)))).toEqual(rejected);
    expect(payload(await errorOf(resolveAllowedPath(path.join(junction, 'a.txt'), [root], evil)))).toEqual(
      rejected,
    );
  });
});

describe('resolveAllowedPath (realpath + allowlist)', () => {
  it('returns the resolved path inside a root and rejects paths outside', async () => {
    const root = await makeTempHome('paths-root-');
    const outside = await makeTempHome('paths-out-');
    const inner = path.join(root, 'sub', 'a.txt');
    await mkdir(path.dirname(inner), { recursive: true });
    await writeFile(inner, 'a', 'utf8');
    await writeFile(path.join(outside, 'b.txt'), 'b', 'utf8');

    const resolved = await resolveAllowedPath(inner, [root]);
    expect(resolved.toLowerCase()).toContain('a.txt');
    expect(payload(await errorOf(resolveAllowedPath(path.join(outside, 'b.txt'), [root])))).toEqual({
      code: 'PATH_NOT_ALLOWED',
      params: {},
    });
  });

  it('follows junctions before the allowlist check', async () => {
    const root = await makeTempHome('paths-root-');
    const outside = await makeTempHome('paths-out-');
    await writeFile(path.join(outside, 'secret.txt'), 's', 'utf8');
    const link = path.join(root, 'escape');
    await symlink(outside, link, 'junction');
    expect(payload(await errorOf(resolveAllowedPath(path.join(link, 'secret.txt'), [root])))).toEqual({
      code: 'PATH_NOT_ALLOWED',
      params: {},
    });
  });

  it('rejects unsafe strings and reports fs errors', async () => {
    const root = await makeTempHome('paths-root-');
    expect(payload(await errorOf(resolveAllowedPath('\\\\host\\share\\x', [root])))?.code).toBe(
      'PATH_REJECTED',
    );
    expect(fsErrorCode(await errorOf(resolveAllowedPath(path.join(root, 'missing.txt'), [root])))).toBe(
      'ENOENT',
    );
    expect(fsErrorCode(new Error('x'))).toBeNull();
  });
});
