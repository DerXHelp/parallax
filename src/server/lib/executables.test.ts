import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isBareProgramName,
  isExecutableFileSync,
  isSpawnableIfPresent,
  posixSystemTool,
} from './executables';
import { nodeFsProbe, resolveExecutable } from './windows';

describe('POSIX programs (WP-103)', () => {
  it('a bare program name is one file name', () => {
    for (const name of ['git', 'xdg-open', 'gnome-terminal', 'node.exe', '.hidden']) {
      expect(isBareProgramName(name), name).toBe(true);
    }
    for (const name of ['', '.', '..', 'bin/git', '/usr/bin/git', 'a\0b', 'a\nb']) {
      expect(isBareProgramName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('system tools: /usr/bin, then /bin; neither → /usr/bin (spawn reports ENOENT); no .exe magic', () => {
    expect(posixSystemTool('ps', (file) => file === '/usr/bin/ps' || file === '/bin/ps')).toBe('/usr/bin/ps');
    expect(posixSystemTool('kill', (file) => file === '/bin/kill')).toBe('/bin/kill');
    expect(posixSystemTool('nope', () => false)).toBe('/usr/bin/nope');
    expect(posixSystemTool('taskkill.exe', () => false)).toBe('/usr/bin/taskkill.exe');
    for (const name of ['', '..', 'sbin/x', '/usr/bin/ps']) {
      expect(() => posixSystemTool(name, () => true), name).toThrow(TypeError);
    }
  });
});

describe.runIf(process.platform === 'linux')('POSIX programs on the real file system (WP-103)', () => {
  // Set up in beforeAll: a skipped suite is still collected (no symlinks on Windows without rights).
  let dir = '';
  let bin = '';
  let other = '';
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'px-exec-'));
    bin = path.join(dir, 'bin');
    other = path.join(dir, 'other');
    mkdirSync(bin);
    mkdirSync(other);
    writeFileSync(path.join(bin, 'tool'), '#!/bin/sh\n');
    chmodSync(path.join(bin, 'tool'), 0o755);
    writeFileSync(path.join(bin, 'plain'), 'x');
    chmodSync(path.join(bin, 'plain'), 0o644);
    writeFileSync(path.join(other, 'plain'), '#!/bin/sh\n');
    chmodSync(path.join(other, 'plain'), 0o755);
    symlinkSync(path.join(bin, 'tool'), path.join(other, 'alias'));
    mkdirSync(path.join(bin, 'folder'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('executable regular files only', () => {
    expect(isExecutableFileSync(path.join(bin, 'tool'))).toBe(true);
    expect(isExecutableFileSync(path.join(bin, 'plain'))).toBe(false);
    expect(isExecutableFileSync(path.join(bin, 'folder'))).toBe(false);
    expect(isExecutableFileSync(path.join(bin, 'missing'))).toBe(false);
    expect(isSpawnableIfPresent(path.join(bin, 'missing'))).toBe(true);
    expect(isSpawnableIfPresent(path.join(bin, 'plain'))).toBe(false);
    expect(isSpawnableIfPresent(path.join(bin, 'folder'))).toBe(false);
  });

  it('resolveExecutable: skips the non-executable hit, keeps the link name', async () => {
    const env = { PATH: `${bin}:${other}` };
    expect(await resolveExecutable('plain', env, nodeFsProbe, 'linux')).toBe(path.join(other, 'plain'));
    expect(await resolveExecutable('alias', env, nodeFsProbe, 'linux')).toBe(path.join(other, 'alias'));
    expect(await resolveExecutable('folder', env, nodeFsProbe, 'linux')).toBeNull();
    expect(await resolveExecutable('sh', { PATH: '/usr/bin:/bin' }, nodeFsProbe, 'linux')).toMatch(
      /^\/(usr\/)?bin\/sh$/,
    );
  });
});
