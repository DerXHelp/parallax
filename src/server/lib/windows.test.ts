import { describe, expect, it } from 'vitest';
import { POSIX_PATHS } from '@shared/paths';
import { createMemoryFs, getEnvVar, resolveCmdShim, resolveExecutable, searchPath } from './windows';

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';

describe('getEnvVar (case-insensitive, Windows semantics)', () => {
  it('finds any spelling and skips undefined values', () => {
    expect(getEnvVar({ Path: 'a' }, 'PATH', 'win32')).toBe('a');
    expect(getEnvVar({ path: undefined, PATH: 'b' }, 'Path', 'win32')).toBe('b');
    expect(getEnvVar({}, 'PATH', 'win32')).toBeUndefined();
  });

  it('POSIX: exact names – http_proxy and HTTP_PROXY are two variables (WP-103)', () => {
    expect(getEnvVar({ Path: 'a' }, 'PATH', 'linux')).toBeUndefined();
    expect(getEnvVar({ http_proxy: 'a', HTTP_PROXY: 'b' }, 'http_proxy', 'linux')).toBe('a');
    expect(getEnvVar({ http_proxy: 'a', HTTP_PROXY: 'b' }, 'HTTP_PROXY', 'linux')).toBe('b');
    // Only own properties: nothing from the prototype.
    expect(getEnvVar({}, 'toString', 'linux')).toBeUndefined();
  });
});

describe('searchPath / resolveCmdShim (moved from claude/, R1-08)', () => {
  it('searches PATH × PATHEXT in where.exe order and resolves npm shims to the .exe', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\pnpm`]: '#!/bin/sh',
      [`${NPM}\\pnpm.cmd`]: '@ECHO off\r\n"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*\r\n',
      [`${NPM}\\node_modules\\pnpm\\pnpm.exe`]: '',
    });
    expect(await searchPath('pnpm', { PATH: NPM, PATHEXT: '.EXE;.CMD' }, fs, 'win32')).toEqual([
      `${NPM}\\pnpm`,
      `${NPM}\\pnpm.cmd`,
    ]);
    expect(await resolveCmdShim(`${NPM}\\pnpm.cmd`, fs, 'pnpm.exe')).toBe(
      `${NPM}\\node_modules\\pnpm\\pnpm.exe`,
    );
  });
});

describe('resolveExecutable (absolute .exe for a bare name, R1-04)', () => {
  const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

  it('returns the first .exe on the PATH – never something in the current directory', async () => {
    const fs = createMemoryFs({ [GIT]: '', 'D:\\cloned-repo\\git.exe': '' });
    const env = { PATH: 'C:\\Program Files\\Git\\cmd;.;relative', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(await resolveExecutable('git', env, fs, 'win32')).toBe(GIT);
    expect(fs.touched.every((p) => p.startsWith('C:\\Program Files\\Git\\cmd\\'))).toBe(true);
  });

  it('falls back to the .exe behind an npm shim and returns null when nothing is found', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\pnpm.cmd`]: '"%dp0%\\node_modules\\pnpm\\pnpm.exe" %*\r\n',
      [`${NPM}\\node_modules\\pnpm\\pnpm.exe`]: '',
    });
    expect(await resolveExecutable('pnpm', { PATH: NPM }, fs, 'win32')).toBe(
      `${NPM}\\node_modules\\pnpm\\pnpm.exe`,
    );
    expect(await resolveExecutable('pnpm.exe', { PATH: NPM }, fs, 'win32')).toBeNull();
    expect(await resolveExecutable('git', { PATH: NPM }, fs, 'win32')).toBeNull();
  });
});

describe('POSIX lookups: PATH at `:`, executable regular files, no PATHEXT (WP-103)', () => {
  const posixFs = (
    files: Record<string, string>,
    options: { notExecutable?: string[]; links?: Record<string, string> } = {},
  ) => createMemoryFs(files, { rules: POSIX_PATHS, ...options });

  it('every executable hit in PATH order – never the current directory, relative or unsafe entries', async () => {
    const fs = posixFs({
      '/home/u/.local/bin/git': '',
      '/usr/bin/git': '',
      '/home/u/repo/git': '',
      '/usr/bin/git.exe': '',
    });
    const env = { PATH: '/home/u/.local/bin::.:bin:/usr/bin:/proc/self:/usr/bin/', PATHEXT: '.EXE' };
    expect(await searchPath('git', env, fs, 'linux')).toEqual(['/home/u/.local/bin/git', '/usr/bin/git']);
    expect(await resolveExecutable('git', env, fs, 'linux')).toBe('/home/u/.local/bin/git');
    // Relative and pseudo file system entries are never touched.
    expect(fs.touched.every((p) => p.startsWith('/home/u/.local/bin/') || p.startsWith('/usr/bin/'))).toBe(
      true,
    );
  });

  it('a file without execute permission is no hit', async () => {
    const fs = posixFs(
      { '/home/u/bin/claude': '', '/usr/local/bin/claude': '' },
      {
        notExecutable: ['/home/u/bin/claude'],
      },
    );
    expect(await resolveExecutable('claude', { PATH: '/home/u/bin:/usr/local/bin' }, fs, 'linux')).toBe(
      '/usr/local/bin/claude',
    );
  });

  it('a link is followed for the check, but the PATH entry is returned; a link into /proc is refused', async () => {
    const fs = posixFs(
      { '/usr/bin/busybox': '', '/usr/bin/sh': '', '/usr/local/bin/claude': '', '/opt/x/claude': '' },
      { links: { '/usr/bin/sh': '/usr/bin/busybox', '/usr/local/bin/claude': '/proc/1/root/claude' } },
    );
    expect(await resolveExecutable('sh', { PATH: '/usr/bin' }, fs, 'linux')).toBe('/usr/bin/sh');
    expect(await resolveExecutable('claude', { PATH: '/usr/local/bin:/opt/x' }, fs, 'linux')).toBe(
      '/opt/x/claude',
    );
  });

  it('PATH is read with its exact name; a name with a path never searches', async () => {
    const fs = posixFs({ '/usr/bin/git': '' });
    expect(await resolveExecutable('git', { Path: '/usr/bin' }, fs, 'linux')).toBeNull();
    expect(await resolveExecutable('git', {}, fs, 'linux')).toBeNull();
    for (const name of ['bin/git', '/usr/bin/git', '..', '.', '']) {
      expect(await searchPath(name, { PATH: '/usr/bin' }, fs, 'linux'), name).toEqual([]);
    }
  });

  it('duplicate PATH entries (also with a trailing slash) are searched once', async () => {
    const fs = posixFs({ '/usr/bin/git': '' });
    expect(await searchPath('git', { PATH: '/usr/bin:/usr/bin/://usr/bin' }, fs, 'linux')).toEqual([
      '/usr/bin/git',
    ]);
  });
});
