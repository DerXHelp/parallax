import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import { FsTimeoutError } from './fsTimeout';
import {
  assertNoUnsafeLink,
  assertSafePath,
  checkCwd,
  fileAccessError,
  fsErrorCode,
  physicalPath,
  physicalRoot,
  resolveAllowedPath,
  resolveLinkTarget,
  type AccessFs,
  type AccessPolicy,
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
    // The drive root itself is never asked; each target is checked before going through it, and
    // the rest of the path continues where the links really lead (R4-10).
    expect(fs.touched).not.toContain('C:\\');
    expect(fs.touched).toEqual(
      expect.arrayContaining([
        'C:\\work',
        'C:\\work\\a',
        'D:\\real\\b',
        'D:\\other',
        'E:\\final',
        'E:\\final\\b',
        'E:\\final\\b\\c',
      ]),
    );
    expect(fs.touched).not.toContain('C:\\work\\a\\b\\c');
  });

  it('R4-10: a relative target behind a link resolves against the folder it really lies in', async () => {
    // C:\a\link → D:\x\y; D:\x\y\b → ..\..\z (= D:\z, not C:\z); D:\z → a share.
    const fs = fakeLinks({
      'C:\\a\\link': 'D:\\x\\y',
      'D:\\x\\y\\b': '..\\..\\z',
      'D:\\z': '\\\\server\\share',
    });
    expect(payload(await errorOf(assertNoUnsafeLink('C:\\a\\link\\b', fs)))).toEqual(rejected);
    expect(payload(await errorOf(assertNoUnsafeLink('C:\\a\\link\\b\\deeper', fs)))).toEqual(rejected);
    expect(fs.touched.some((p) => p.startsWith('\\\\'))).toBe(false);
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
    const allowed = await resolveAllowedPath(path.join(junction, 'a.txt'), cwdPolicy(root));
    expect(allowed.realPath.toLowerCase()).toContain(path.join('target', 'a.txt').toLowerCase());
    expect(allowed.access).toBe('cwd');
    // The same paths with a fake fs that reports the junction as a link to a share.
    const evil = fakeLinks({ [junction]: '\\\\server\\share' });
    expect(payload(await errorOf(checkCwd(junction, evil)))).toEqual(rejected);
    const evilAccess: AccessFs = { ...evil, realpath: () => Promise.reject(new Error('never called')) };
    expect(
      payload(
        await errorOf(resolveAllowedPath(path.join(junction, 'a.txt'), cwdPolicy(root), { fs: evilAccess })),
      ),
    ).toEqual(rejected);
  });
});

function cwdPolicy(root: string): AccessPolicy<'cwd'> {
  return { roots: [{ path: root, kind: 'cwd' }] };
}

const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

/**
 * Recording AccessFs: `links` (readlink targets), `real` (realpath answers, default = the path
 * itself), `fail` (an error per path for lstat and realpath). `calls` lists `<op>:<path>`.
 */
function fakeAccess(
  setup: { links?: Record<string, string>; real?: Record<string, string>; fail?: Record<string, Error> } = {},
): AccessFs & { calls: string[] } {
  const key = (p: string) => p.toLowerCase().replace(/\//g, '\\');
  const links = new Map(Object.entries(setup.links ?? {}).map(([p, t]) => [key(p), t]));
  const real = new Map(Object.entries(setup.real ?? {}).map(([p, t]) => [key(p), t]));
  const fail = new Map(Object.entries(setup.fail ?? {}).map(([p, e]) => [key(p), e]));
  const calls: string[] = [];
  const failure = (p: string): Error | undefined => fail.get(key(p));
  return {
    calls,
    lstat: (p) => {
      calls.push(`lstat:${p}`);
      const error = failure(p);
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve({ isSymbolicLink: () => links.has(key(p)) });
    },
    readlink: (p) => {
      calls.push(`readlink:${p}`);
      const target = links.get(key(p));
      return target === undefined ? Promise.reject(new Error('EINVAL')) : Promise.resolve(target);
    },
    realpath: (p) => {
      calls.push(`realpath:${p}`);
      const error = failure(p);
      if (error !== undefined) return Promise.reject(error);
      return Promise.resolve(real.get(key(p)) ?? p);
    },
  };
}

describe('resolveAllowedPath (ADR-141 check chain)', () => {
  type Kind = 'cwd' | 'additional' | 'session';
  const policy = (listed: string[] = [], onKeys?: () => void): AccessPolicy<Kind> => ({
    roots: [
      { path: 'C:\\work\\project', kind: 'cwd' },
      { path: 'D:\\shared', kind: 'additional' },
      { path: '\\\\server\\share', kind: 'additional' },
    ],
    listed: {
      kind: 'session',
      keys: () => {
        onKeys?.();
        return Promise.resolve(new Set(listed.map((p) => p.toLowerCase())));
      },
    },
  });

  it('(1) unsafe strings: PATH_REJECTED before the policy, the index or any fs call', async () => {
    for (const [input, reason] of [
      ['\\\\host\\share\\x', 'unc'],
      ['//host/x', 'unc'],
      ['\\\\?\\C:\\x', 'device'],
      ['C:\\work\\project\\a.txt:secret', 'ads'],
      ['C:\\work\\project\\..\\x', 'dot_segment'],
    ] as const) {
      const fs = fakeAccess();
      let keysAsked = 0;
      const error = await errorOf(
        resolveAllowedPath(
          input,
          policy([], () => (keysAsked += 1)),
          { fs },
        ),
      );
      expect(payload(error)).toEqual({ code: 'PATH_REJECTED', params: { reason } });
      expect(fs.calls).toEqual([]);
      expect(keysAsked).toBe(0);
    }
  });

  it('(2) outside the roots and not listed: PATH_NOT_ALLOWED without any fs call', async () => {
    const fs = fakeAccess();
    let resolved = 0;
    const options = {
      fs,
      resolveRoot: (root: string) => {
        resolved += 1;
        return Promise.resolve(root);
      },
    };
    for (const input of ['C:\\Windows\\win.ini', 'C:\\work\\projectX\\a.txt', 'E:\\secret.txt']) {
      expect(payload(await errorOf(resolveAllowedPath(input, policy(), options)))).toEqual({
        code: 'PATH_NOT_ALLOWED',
        params: {},
      });
    }
    expect(fs.calls).toEqual([]);
    expect(resolved).toBe(0);
  });

  it('an unsafe root string is ignored and never touched', async () => {
    const fs = fakeAccess();
    const touchedRoots: string[] = [];
    const options = {
      fs,
      resolveRoot: (root: string) => {
        touchedRoots.push(root);
        return Promise.resolve(root);
      },
    };
    expect(payload(await errorOf(resolveAllowedPath('C:\\x\\a.txt', policy(), options)))?.code).toBe(
      'PATH_NOT_ALLOWED',
    );
    await resolveAllowedPath('D:\\shared\\a.txt', policy(), options);
    expect(touchedRoots.some((root) => root.startsWith('\\\\'))).toBe(false);
    expect(fs.calls.some((call) => call.includes('\\\\'))).toBe(false);
  });

  it('(2→5) below a root: link walk, realpath, then the root that contains the target names the access', async () => {
    const fs = fakeAccess();
    const result = await resolveAllowedPath('D:\\shared\\docs\\a.md', policy(), { fs });
    expect(result).toEqual({ realPath: 'D:\\shared\\docs\\a.md', access: 'additional' });
    // Steps in order: lstat per segment, then realpath of the file; roots resolved afterwards.
    expect(fs.calls.slice(0, 4)).toEqual([
      'lstat:D:\\shared',
      'lstat:D:\\shared\\docs',
      'lstat:D:\\shared\\docs\\a.md',
      'realpath:D:\\shared\\docs\\a.md',
    ]);
  });

  it('compares case-insensitively and keeps the requested string out of the result', async () => {
    const fs = fakeAccess({ real: { 'c:\\WORK\\Project\\A.txt': 'C:\\work\\project\\A.txt' } });
    const result = await resolveAllowedPath('c:\\WORK\\Project\\A.txt', policy(), { fs });
    expect(result).toEqual({ realPath: 'C:\\work\\project\\A.txt', access: 'cwd' });
  });

  it('a path listed in the index is allowed outside the roots (exact key)', async () => {
    const fs = fakeAccess();
    const result = await resolveAllowedPath('E:\\notes\\plan.md', policy(['E:\\Notes\\Plan.md']), { fs });
    expect(result).toEqual({ realPath: 'E:\\notes\\plan.md', access: 'session' });
    // Its folder is not listed: a sibling stays forbidden, without an fs call.
    const before = fs.calls.length;
    expect(
      payload(
        await errorOf(resolveAllowedPath('E:\\notes\\other.md', policy(['E:\\notes\\plan.md']), { fs })),
      )?.code,
    ).toBe('PATH_NOT_ALLOWED');
    expect(fs.calls.length).toBe(before);
  });

  it('(3) a link to a share on the way: PATH_REJECTED link_target, realpath never called', async () => {
    const fs = fakeAccess({ links: { 'C:\\work\\project\\share': '\\\\evil\\s' } });
    const error = await errorOf(resolveAllowedPath('C:\\work\\project\\share\\x.txt', policy(), { fs }));
    expect(payload(error)).toEqual({ code: 'PATH_REJECTED', params: { reason: 'link_target' } });
    expect(fs.calls.some((call) => call.startsWith('realpath:'))).toBe(false);
    expect(fs.calls.some((call) => call.includes('\\\\evil'))).toBe(false);
  });

  it('(4) an unsafe realpath result is rejected; a mapped drive keeps its walked path', async () => {
    const device = fakeAccess({ real: { 'C:\\work\\project\\a.txt': '\\\\?\\Volume{1}\\a.txt' } });
    expect(
      payload(await errorOf(resolveAllowedPath('C:\\work\\project\\a.txt', policy(), { fs: device }))),
    ).toEqual({
      code: 'PATH_REJECTED',
      params: { reason: 'device' },
    });
    // Z: is a mapped network drive: realpath names the share, no link leads there → Z:\… stands.
    const mapped = fakeAccess({
      real: { 'Z:\\repo\\a.txt': '\\\\nas\\repo\\a.txt', 'Z:\\repo': '\\\\nas\\repo' },
    });
    const zPolicy: AccessPolicy<'cwd'> = { roots: [{ path: 'Z:\\repo', kind: 'cwd' }] };
    expect(await resolveAllowedPath('Z:\\repo\\a.txt', zPolicy, { fs: mapped })).toEqual({
      realPath: 'Z:\\repo\\a.txt',
      access: 'cwd',
    });
  });

  it('(5) a link inside a root that leads out of it: PATH_NOT_ALLOWED', async () => {
    const fs = fakeAccess({
      links: { 'C:\\work\\project\\escape': 'C:\\Users\\me\\secrets' },
      real: { 'C:\\work\\project\\escape\\key.txt': 'C:\\Users\\me\\secrets\\key.txt' },
    });
    expect(
      payload(await errorOf(resolveAllowedPath('C:\\work\\project\\escape\\key.txt', policy(), { fs }))),
    ).toEqual({
      code: 'PATH_NOT_ALLOWED',
      params: {},
    });
    // …unless the target itself is listed in the index.
    const listed = policy(['C:\\Users\\me\\secrets\\key.txt']);
    expect(await resolveAllowedPath('C:\\work\\project\\escape\\key.txt', listed, { fs })).toEqual({
      realPath: 'C:\\Users\\me\\secrets\\key.txt',
      access: 'session',
    });
  });

  it('roots are compared by their physical path (resolveRoot, e.g. a cwd behind a junction)', async () => {
    const fs = fakeAccess({ real: { 'C:\\work\\project\\a.txt': 'E:\\real\\project\\a.txt' } });
    const resolveRoot = (root: string) =>
      Promise.resolve(root === 'C:\\work\\project' ? 'E:\\real\\project' : root);
    expect(await resolveAllowedPath('C:\\work\\project\\a.txt', policy(), { fs, resolveRoot })).toEqual({
      realPath: 'E:\\real\\project\\a.txt',
      access: 'cwd',
    });
  });

  it.each([
    [enoent(), { code: 'FILE_NOT_FOUND', params: {} }],
    [Object.assign(new Error('x'), { code: 'ENOTDIR' }), { code: 'FILE_NOT_FOUND', params: {} }],
    [
      Object.assign(new Error('x'), { code: 'EACCES' }),
      { code: 'FILE_NOT_READABLE', params: { reason: 'access' } },
    ],
    [
      Object.assign(new Error('x'), { code: 'EPERM' }),
      { code: 'FILE_NOT_READABLE', params: { reason: 'access' } },
    ],
    [
      Object.assign(new Error('x'), { code: 'EBUSY' }),
      { code: 'FILE_NOT_READABLE', params: { reason: 'busy' } },
    ],
    [new FsTimeoutError('c:'), { code: 'FILE_NOT_READABLE', params: { reason: 'timeout' } }],
  ])('fs failure %s → contract error', async (failure, expected) => {
    const fs = fakeAccess({ fail: { 'C:\\work\\project\\a.txt': failure } });
    expect(payload(await errorOf(resolveAllowedPath('C:\\work\\project\\a.txt', policy(), { fs })))).toEqual(
      expected,
    );
  });

  it('fileAccessError keeps CommandErrors and non-fs errors', () => {
    const command = new CommandError({ code: 'PATH_NOT_ALLOWED', params: {} });
    expect(fileAccessError(command)).toBe(command);
    const plain = new Error('boom');
    expect(fileAccessError(plain)).toBe(plain);
    expect(payload(fileAccessError(Object.assign(new Error('x'), { code: 'EIO' })))).toEqual({
      code: 'FILE_NOT_READABLE',
      params: { reason: 'eio' },
    });
  });

  it('physicalRoot: null for unsafe or missing roots (never touched when unsafe)', async () => {
    const fs = fakeAccess({ fail: { 'C:\\gone': enoent() } });
    expect(await physicalRoot('\\\\server\\share', fs)).toBeNull();
    expect(fs.calls).toEqual([]);
    expect(await physicalRoot('C:\\gone', fs)).toBeNull();
    expect(await physicalPath('C:\\work', fs)).toBe('C:\\work');
  });
});

describe('resolveAllowedPath on the real file system', () => {
  it('returns the physical path inside a root and rejects paths outside', async () => {
    const root = await makeTempHome('paths-root-');
    const outside = await makeTempHome('paths-out-');
    const inner = path.join(root, 'sub', 'a.txt');
    await mkdir(path.dirname(inner), { recursive: true });
    await writeFile(inner, 'a', 'utf8');
    await writeFile(path.join(outside, 'b.txt'), 'b', 'utf8');

    const resolved = await resolveAllowedPath(inner, cwdPolicy(root));
    expect(resolved.realPath.toLowerCase()).toContain('a.txt');
    expect(resolved.access).toBe('cwd');
    expect(payload(await errorOf(resolveAllowedPath(path.join(outside, 'b.txt'), cwdPolicy(root))))).toEqual({
      code: 'PATH_NOT_ALLOWED',
      params: {},
    });
  });

  it('follows junctions before the policy on the target', async () => {
    const root = await makeTempHome('paths-root-');
    const outside = await makeTempHome('paths-out-');
    await writeFile(path.join(outside, 'secret.txt'), 's', 'utf8');
    const link = path.join(root, 'escape');
    await symlink(outside, link, 'junction');
    expect(
      payload(await errorOf(resolveAllowedPath(path.join(link, 'secret.txt'), cwdPolicy(root)))),
    ).toEqual({
      code: 'PATH_NOT_ALLOWED',
      params: {},
    });
  });

  it('rejects unsafe strings and maps a missing file to FILE_NOT_FOUND', async () => {
    const root = await makeTempHome('paths-root-');
    expect(payload(await errorOf(resolveAllowedPath('\\\\host\\share\\x', cwdPolicy(root))))?.code).toBe(
      'PATH_REJECTED',
    );
    expect(
      payload(await errorOf(resolveAllowedPath(path.join(root, 'missing.txt'), cwdPolicy(root)))),
    ).toEqual({
      code: 'FILE_NOT_FOUND',
      params: {},
    });
    expect(fsErrorCode(new Error('x'))).toBeNull();
  });
});
