import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/common';
import { SAMPLE_IDS } from '@shared/samples';
import { makeTempHome } from '../http/testServer';
import type { RunFileFn, RunFileOptions, RunFileResult } from '../lib/process';
import { nodeFileFs, type FileFs } from './fileFs';
import {
  GIT_LS_FILES_ARGS,
  GIT_LS_FILES_MAX_OUTPUT_BYTES,
  GIT_LS_FILES_TIMEOUT_MS,
  PROJECT_FILES_CACHE_MS,
  PROJECT_WALK_MAX_DEPTH,
  createProjectFiles,
  parseLsFiles,
} from './projectFiles';

const ENTRY = SAMPLE_IDS.entry;
const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';

interface RunCall {
  file: string;
  args: readonly string[];
  options: RunFileOptions;
}

function fakeRun(result: Partial<RunFileResult> | Error): RunFileFn & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: RunFileFn = (file, args, options) => {
    calls.push({ file, args, options });
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...result });
  };
  return Object.assign(run, { calls });
}

describe('parseLsFiles', () => {
  it('splits NUL-separated output, drops duplicates, uses / separators', () => {
    expect(parseLsFiles('a.ts\0src/b.ts\0src\\c.ts\0a.ts\0')).toEqual(['a.ts', 'src/b.ts', 'src/c.ts']);
    expect(parseLsFiles('')).toEqual([]);
    expect(parseLsFiles('Grüße.md\0')).toEqual(['Grüße.md']);
  });

  it('a cut output loses its incomplete last path', () => {
    expect(parseLsFiles('a.ts\0b.ts\0partial/pa')).toEqual(['a.ts', 'b.ts']);
  });
});

describe('createProjectFiles (ADR-151)', () => {
  it('git ls-files with the absolute git.exe, exact arguments, 5 s, 8 MB', async () => {
    const run = fakeRun({ stdout: 'README.md\0src/main.ts\0' });
    const files = createProjectFiles({ fs: nodeFileFs, resolveGit: () => Promise.resolve(GIT), run });
    expect(await files.list(ENTRY, 'D:\\work\\sample')).toEqual({
      root: 'D:\\work\\sample',
      files: ['README.md', 'src/main.ts'],
      truncated: false,
      source: 'git',
    });
    expect(run.calls).toEqual([
      {
        file: GIT,
        args: GIT_LS_FILES_ARGS,
        options: {
          cwd: 'D:\\work\\sample',
          env: undefined,
          timeoutMs: GIT_LS_FILES_TIMEOUT_MS,
          maxOutputBytes: GIT_LS_FILES_MAX_OUTPUT_BYTES,
        },
      },
    ]);
    expect(GIT_LS_FILES_ARGS).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.quotepath=off',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
  });

  it(`at most ${String(LIMITS.projectFilesMax)} paths (truncated); an output at the size limit is truncated`, async () => {
    const many = Array.from({ length: LIMITS.projectFilesMax + 5 }, (_, i) => `f${String(i)}.ts\0`).join('');
    const files = createProjectFiles({
      fs: nodeFileFs,
      resolveGit: () => Promise.resolve(GIT),
      run: fakeRun({ stdout: many }),
    });
    const list = await files.list(ENTRY, 'D:\\work\\sample');
    expect(list.files).toHaveLength(LIMITS.projectFilesMax);
    expect(list.truncated).toBe(true);

    // runFile stops collecting at the limit: an output of exactly that size was cut.
    const full = 'x'.repeat(GIT_LS_FILES_MAX_OUTPUT_BYTES - 'a.ts\0'.length);
    const cut = createProjectFiles({
      fs: nodeFileFs,
      resolveGit: () => Promise.resolve(GIT),
      run: fakeRun({ stdout: `a.ts\0${full}` }),
    });
    expect(await cut.list(ENTRY, 'D:\\work\\sample')).toMatchObject({
      files: ['a.ts'],
      truncated: true,
      source: 'git',
    });
  });

  describe('fallback walk', () => {
    async function project(): Promise<string> {
      const root = await makeTempHome('project-');
      await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
      await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(path.join(root, '.git'), { recursive: true });
      await mkdir(path.join(root, 'Build'), { recursive: true });
      await writeFile(path.join(root, 'b.md'), 'b');
      await writeFile(path.join(root, 'a.ts'), 'a');
      await writeFile(path.join(root, 'src', 'main.ts'), 'm');
      await writeFile(path.join(root, 'src', 'deep', 'x.ts'), 'x');
      await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'i');
      await writeFile(path.join(root, '.git', 'HEAD'), 'h');
      await writeFile(path.join(root, 'Build', 'out.js'), 'o');
      const outside = await makeTempHome('outside-');
      await writeFile(path.join(outside, 'secret.txt'), 's');
      await symlink(outside, path.join(root, 'linked'), 'junction');
      return root;
    }

    it.each([
      ['no repository (git exits 128)', { exitCode: 128 }],
      ['git timed out', { timedOut: true, exitCode: null }],
    ] as const)('%s → walk without links and ignored folders, shallow files first', async (_name, result) => {
      const root = await project();
      const files = createProjectFiles({
        fs: nodeFileFs,
        resolveGit: () => Promise.resolve(GIT),
        run: fakeRun(result),
      });
      expect(await files.list(ENTRY, root)).toEqual({
        root,
        files: ['a.ts', 'b.md', 'src/main.ts', 'src/deep/x.ts'],
        truncated: false,
        source: 'walk',
      });
    });

    it('no git installed, or git cannot start → walk', async () => {
      const root = await project();
      const noGit = createProjectFiles({ fs: nodeFileFs, resolveGit: () => Promise.resolve(null) });
      expect((await noGit.list(ENTRY, root)).source).toBe('walk');
      const blocked = createProjectFiles({
        fs: nodeFileFs,
        resolveGit: () => Promise.resolve(GIT),
        run: fakeRun(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
      });
      expect((await blocked.list(ENTRY, root)).source).toBe('walk');
    });

    it(`stops at depth ${String(PROJECT_WALK_MAX_DEPTH)} and after the time budget`, async () => {
      const root = await makeTempHome('deep-');
      let dir = root;
      for (let depth = 0; depth <= PROJECT_WALK_MAX_DEPTH + 1; depth += 1) {
        await writeFile(path.join(dir, `f${String(depth)}.txt`), 'x');
        dir = path.join(dir, 'd');
        await mkdir(dir);
      }
      const files = createProjectFiles({ fs: nodeFileFs, resolveGit: () => Promise.resolve(null) });
      const list = await files.list(ENTRY, root);
      expect(list.files).toHaveLength(PROJECT_WALK_MAX_DEPTH + 1);
      expect(list.files.at(-1)).toBe(
        `${'d/'.repeat(PROJECT_WALK_MAX_DEPTH)}f${String(PROJECT_WALK_MAX_DEPTH)}.txt`,
      );

      // A clock that jumps 2 s per folder: the 3 s budget ends the walk (truncated).
      let clock = 0;
      const slowFs: FileFs = {
        ...nodeFileFs,
        readdir: (folder) => {
          clock += 2_000;
          return nodeFileFs.readdir(folder);
        },
      };
      const slow = createProjectFiles({
        fs: slowFs,
        resolveGit: () => Promise.resolve(null),
        now: () => clock,
      });
      const cut = await slow.list(ENTRY, root);
      expect(cut.truncated).toBe(true);
      expect(cut.files.length).toBeLessThan(PROJECT_WALK_MAX_DEPTH + 1);
    });
  });

  it('cache: 30 s per entry and cwd; invalidate drops it', async () => {
    let clock = 0;
    const run = fakeRun({ stdout: 'a.ts\0' });
    const files = createProjectFiles({
      fs: nodeFileFs,
      resolveGit: () => Promise.resolve(GIT),
      run,
      now: () => clock,
    });
    await files.list(ENTRY, 'D:\\work\\sample');
    clock += PROJECT_FILES_CACHE_MS - 1;
    await files.list(ENTRY, 'D:\\work\\sample');
    expect(run.calls).toHaveLength(1);
    clock += 1;
    await files.list(ENTRY, 'D:\\work\\sample');
    expect(run.calls).toHaveLength(2);
    files.invalidate(ENTRY);
    await files.list(ENTRY, 'D:\\work\\sample');
    expect(run.calls).toHaveLength(3);
    await files.list(ENTRY, 'D:\\work\\other');
    expect(run.calls).toHaveLength(4);
  });
});
