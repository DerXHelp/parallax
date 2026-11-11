/**
 * Real files of the FakeBackend (WP-52): only below `<root>\<sessionId>\`, every escape rejected
 * before any file system access; the default root lies in the OS temp folder.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isWindowsPathInside } from '@shared/paths';
import { FAKE_FILES_DIR_NAME, FakeFiles, defaultFakeFilesRoot, patchHunks } from './files';

const temp = mkdtempSync(path.join(os.tmpdir(), 'parallax-fake-files-unit-'));
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

const SESSION = '5e550000-0000-4000-8000-0000000000aa';

describe('FakeFiles', () => {
  it('the default root is %TEMP%\\parallax-fake-files', () => {
    expect(defaultFakeFilesRoot()).toBe(path.join(os.tmpdir(), FAKE_FILES_DIR_NAME));
    expect(isWindowsPathInside(defaultFakeFilesRoot(), os.tmpdir())).toBe(true);
  });

  it('writes, appends and reads below <root>\\<sessionId>', async () => {
    const root = mkdtempSync(path.join(temp, 'rw-'));
    const files = new FakeFiles(root, SESSION);
    expect(files.dir).toBe(path.join(root, SESSION));
    const target = await files.write('plans\\fake-plan.md', '# v1\n');
    expect(target).toBe(path.join(root, SESSION, 'plans', 'fake-plan.md'));
    await files.append('plans\\fake-plan.md', '- more\n');
    await expect(files.read('plans\\fake-plan.md')).resolves.toBe('# v1\n- more\n');
    await expect(files.exists('plans\\fake-plan.md')).resolves.toBe(true);
    await expect(files.exists('plans')).resolves.toBe(false);
    await expect(files.exists('missing.txt')).resolves.toBe(false);
    expect(files.path('a/b.txt')).toBe(path.join(root, SESSION, 'a', 'b.txt'));
  });

  it('rejects every path that leaves the session folder – before touching the disk', async () => {
    const root = mkdtempSync(path.join(temp, 'escape-'));
    const files = new FakeFiles(root, SESSION);
    for (const bad of [
      '..\\escape.txt',
      'plans\\..\\..\\escape.txt',
      '../escape.txt',
      'C:\\Windows\\escape.txt',
      '\\\\fake-host\\share\\x.txt',
      '\\\\?\\C:\\escape.txt',
      'notes.txt:stream',
      '',
      '.',
    ]) {
      expect(() => files.path(bad), bad).toThrow();
      await expect(files.write(bad, 'x'), bad).rejects.toThrow();
    }
    // Nothing was created: neither beside the session folder nor in it.
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(path.join(root, 'escape.txt'))).toBe(false);
  });

  it('rejects session ids that are no folder name and roots that are no plain local path', () => {
    for (const id of ['..', '../x', 'a\\b', 'a/b', '', '.hidden', 'x'.repeat(101)]) {
      expect(() => new FakeFiles(temp, id), id).toThrow();
    }
    for (const root of ['\\\\fake-host\\share', 'relative\\root', '\\\\?\\C:\\x']) {
      expect(() => new FakeFiles(root, SESSION), root).toThrow();
    }
  });
});

describe('patchHunks', () => {
  it('builds the CLI structuredPatch hunks of old → new', () => {
    const old = 'a\nb\nc\nd\ne\n';
    const next = 'a\nb\nC\nd\ne\n';
    expect(patchHunks(old, next)).toEqual([
      { oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [' a', ' b', '-c', '+C', ' d', ' e'] },
    ]);
    expect(patchHunks('same\n', 'same\n')).toEqual([]);
  });
});
