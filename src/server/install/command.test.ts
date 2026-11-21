import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCRIPT_MODE, ensureCommand, isOnPath, removeCommand } from './command';
import { commandScriptRoot } from './templates';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A bin folder and two installation roots below a fresh test folder (never the real ~/.local). */
async function world() {
  const base = await mkdtemp(path.join(process.env.PARALLAX_HOME ?? os.tmpdir(), 'wp108-command-'));
  temps.push(base);
  const binDir = path.posix.join(base, 'bin');
  return { base, binDir, file: path.posix.join(binDir, 'parallax'), root: path.posix.join(base, 'lib') };
}

describe('the parallax command (Linux, WP-108)', () => {
  it('writes the command of its root, refreshes it and removes only its own', async () => {
    const w = await world();
    expect(await ensureCommand({ root: w.root, binDir: w.binDir })).toEqual({ ok: true, file: w.file });
    const text = await readFile(w.file, 'utf8');
    expect(commandScriptRoot(text)).toBe(w.root);
    expect(text).toContain(`${w.root}/parallax`);
    // Again: unchanged, still ok.
    expect(await ensureCommand({ root: w.root, binDir: w.binDir })).toEqual({ ok: true, file: w.file });
    expect(await readFile(w.file, 'utf8')).toBe(text);

    // Another root leaves it alone, in both directions.
    const other = path.posix.join(w.base, 'other');
    const refused = await ensureCommand({ root: other, binDir: w.binDir });
    expect(refused).toMatchObject({ ok: false, file: w.file });
    expect(refused.ok ? '' : refused.reason).toContain(`installation in ${w.root}`);
    expect(await removeCommand({ root: other, binDir: w.binDir })).toEqual({ ok: true, file: w.file });
    expect(await readFile(w.file, 'utf8')).toBe(text);

    expect(await removeCommand({ root: w.root, binDir: w.binDir })).toEqual({ ok: true, file: w.file });
    await expect(stat(w.file)).rejects.toThrow();
    // Nothing there: removing again is done as well.
    expect(await removeCommand({ root: w.root, binDir: w.binDir })).toEqual({ ok: true, file: w.file });
  });

  it('never replaces or removes a foreign file or a folder', async () => {
    const w = await world();
    await mkdir(w.binDir, { recursive: true });
    await writeFile(w.file, '#!/bin/sh\necho another parallax\n');
    const foreign = await ensureCommand({ root: w.root, binDir: w.binDir });
    expect(foreign).toMatchObject({ ok: false });
    expect(foreign.ok ? '' : foreign.reason).toContain('another program');
    expect(await removeCommand({ root: w.root, binDir: w.binDir })).toMatchObject({ ok: true });
    expect(await readFile(w.file, 'utf8')).toBe('#!/bin/sh\necho another parallax\n');

    await rm(w.file);
    await mkdir(w.file);
    expect(await ensureCommand({ root: w.root, binDir: w.binDir })).toMatchObject({ ok: false });
    expect((await stat(w.file)).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('is executable and leaves a link alone', async () => {
    const w = await world();
    await ensureCommand({ root: w.root, binDir: w.binDir });
    expect((await stat(w.file)).mode & 0o777).toBe(SCRIPT_MODE);
    await rm(w.file);
    const target = path.posix.join(w.base, 'target');
    await writeFile(target, '#!/bin/sh\n');
    await symlink(target, w.file);
    expect(await ensureCommand({ root: w.root, binDir: w.binDir })).toMatchObject({ ok: false });
    expect(await readFile(target, 'utf8')).toBe('#!/bin/sh\n');
  });

  it('knows whether the bin folder is on the PATH (absolute entries, exact)', () => {
    const env = { PATH: '/usr/local/bin::/home/demo/.local/bin/:relative' };
    expect(isOnPath('/home/demo/.local/bin', env)).toBe(true);
    expect(isOnPath('/home/Demo/.local/bin', env)).toBe(false);
    expect(isOnPath('/opt/bin', env)).toBe(false);
    expect(isOnPath('/opt/bin', {})).toBe(false);
  });
});
