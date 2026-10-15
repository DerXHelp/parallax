import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../http/testServer';
import { CommandError } from '../sync/ports';
import { assertSafePath, checkCwd, fsErrorCode, resolveAllowedPath } from './paths';

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
