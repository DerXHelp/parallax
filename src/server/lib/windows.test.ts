import { describe, expect, it } from 'vitest';
import { createMemoryFs, getEnvVar, resolveCmdShim, resolveExecutable, searchPath } from './windows';

const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';

describe('getEnvVar (case-insensitive, Windows semantics)', () => {
  it('finds any spelling and skips undefined values', () => {
    expect(getEnvVar({ Path: 'a' }, 'PATH')).toBe('a');
    expect(getEnvVar({ path: undefined, PATH: 'b' }, 'Path')).toBe('b');
    expect(getEnvVar({}, 'PATH')).toBeUndefined();
  });
});

describe('searchPath / resolveCmdShim (moved from claude/, R1-08)', () => {
  it('searches PATH × PATHEXT in where.exe order and resolves npm shims to the .exe', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\pnpm`]: '#!/bin/sh',
      [`${NPM}\\pnpm.cmd`]: '@ECHO off\r\n"%dp0%\\node_modules\\pnpm\\pnpm.exe"   %*\r\n',
      [`${NPM}\\node_modules\\pnpm\\pnpm.exe`]: '',
    });
    expect(await searchPath('pnpm', { PATH: NPM, PATHEXT: '.EXE;.CMD' }, fs)).toEqual([
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
    expect(await resolveExecutable('git', env, fs)).toBe(GIT);
    expect(fs.touched.every((p) => p.startsWith('C:\\Program Files\\Git\\cmd\\'))).toBe(true);
  });

  it('falls back to the .exe behind an npm shim and returns null when nothing is found', async () => {
    const fs = createMemoryFs({
      [`${NPM}\\pnpm.cmd`]: '"%dp0%\\node_modules\\pnpm\\pnpm.exe" %*\r\n',
      [`${NPM}\\node_modules\\pnpm\\pnpm.exe`]: '',
    });
    expect(await resolveExecutable('pnpm', { PATH: NPM }, fs)).toBe(`${NPM}\\node_modules\\pnpm\\pnpm.exe`);
    expect(await resolveExecutable('pnpm.exe', { PATH: NPM }, fs)).toBeNull();
    expect(await resolveExecutable('git', { PATH: NPM }, fs)).toBeNull();
  });
});
