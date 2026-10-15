import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEV_WEB_PORT as SHARED_DEV_WEB_PORT } from './src/shared/http.ts';
import { DEV_WEB_PORT, devWebPort, insideDir, resolveBuildId, watchIgnores } from './repo.config.ts';

const root = path.resolve('/r');
const at = (...parts: string[]) => path.join(root, ...parts);

function ignored(repoRoot: string, file: string): boolean {
  return watchIgnores(repoRoot).some((matches) => matches(file));
}

describe('watchIgnores (R1W-01)', () => {
  it('ignores worktrees, dist and .tsbuild of this checkout only', () => {
    expect(ignored(root, at('.worktrees', 'wp-15', 'src', 'x.ts'))).toBe(true);
    expect(ignored(root, at('.worktrees'))).toBe(true);
    expect(ignored(root, at('.claude', 'worktrees', 'a', 'b.ts'))).toBe(true);
    expect(ignored(root, at('dist', 'a.js'))).toBe(true);
    expect(ignored(root, at('.tsbuild', 'web.tsbuildinfo'))).toBe(true);
    expect(ignored(root, at('src', 'x.ts'))).toBe(false);
    expect(ignored(root, at('src', 'dist', 'x.ts'))).toBe(false);
    expect(ignored(root, at('.claude', 'settings.json'))).toBe(false);
    expect(ignored(root, path.resolve('/other', 'dist', 'a.js'))).toBe(false);
  });

  it('does not hide the files of a checkout that lives in .worktrees/<wp>', () => {
    const worktree = at('.worktrees', 'wp-15');
    expect(ignored(worktree, path.join(worktree, 'src', 'web', 'App.tsx'))).toBe(false);
    expect(ignored(worktree, path.join(worktree, 'dist', 'web', 'index.html'))).toBe(true);
  });

  it('also matches forward slashes', () => {
    const unix = (p: string) => p.replaceAll('\\', '/');
    expect(insideDir(at('dist'))(unix(at('dist', 'a.js')))).toBe(true);
    expect(insideDir(at('dist'))(unix(at('distx', 'a.js')))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    expect(ignored(root, at('.WORKTREES', 'wp-15', 'x.ts'))).toBe(true);
    expect(ignored(root.toUpperCase(), at('dist', 'a.js'))).toBe(true);
  });
});

describe('devWebPort (ADR-030)', () => {
  it('defaults to the shared DEV_WEB_PORT and accepts an env override', () => {
    expect(DEV_WEB_PORT).toBe(SHARED_DEV_WEB_PORT);
    expect(devWebPort({})).toBe(DEV_WEB_PORT);
    expect(devWebPort({ PARALLAX_DEV_WEB_PORT: '' })).toBe(DEV_WEB_PORT);
    expect(devWebPort({ PARALLAX_DEV_WEB_PORT: '5175' })).toBe(5175);
  });

  it('rejects invalid ports', () => {
    expect(() => devWebPort({ PARALLAX_DEV_WEB_PORT: 'abc' })).toThrow(/PARALLAX_DEV_WEB_PORT/);
    expect(() => devWebPort({ PARALLAX_DEV_WEB_PORT: '80' })).toThrow(/PARALLAX_DEV_WEB_PORT/);
    expect(() => devWebPort({ PARALLAX_DEV_WEB_PORT: '70000' })).toThrow(/PARALLAX_DEV_WEB_PORT/);
  });
});

// resolveBuildId cases spawn about ten git processes each – under a parallel `pnpm check` (virus
// scanner, other worktrees) one spawn can take seconds: generous limits like the other process tests.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

describe('resolveBuildId (ADR-013/036, R3-13)', () => {
  const temp: string[] = [];
  afterAll(async () => {
    for (const dir of temp) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /**
   * A throw-away repo; its git commands ignore the user's global config (hooks, signing). The system
   * config (core.autocrlf of Git for Windows) stays – resolveBuildId reads with it as well.
   */
  async function repo(): Promise<{
    dir: string;
    git: (...args: string[]) => string;
    write: (file: string, text: string) => Promise<void>;
  }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'r3-buildid-'));
    temp.push(dir);
    const emptyConfig = path.join(dir, '..', `${path.basename(dir)}.gitconfig`);
    await writeFile(emptyConfig, '');
    temp.push(emptyConfig);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const write = async (file: string, text: string) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    };
    git('init', '-q');
    await write('package.json', JSON.stringify({ name: 'x', version: '1.2.3' }));
    await write('src/a.ts', 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'code');
    return { dir, git, write };
  }

  const id = (dir: string) => resolveBuildId(dir, {});

  it('docs-only and test-only commits keep the id; a source commit changes it', async () => {
    const { dir, git, write } = await repo();
    const first = id(dir);
    expect(first).toBe(`1.2.3+${git('rev-parse', 'HEAD').slice(0, 12)}`);

    await write('docs/progress.md', '# docs\n');
    await write('src/README.md', '# readme\n');
    await write('src/a.test.ts', 'test\n');
    await write('src/__snapshots__/x.json', '{}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'docs and tests');
    expect(id(dir)).toBe(first);

    await write('src/a.ts', 'export const a = 2;\n');
    git('commit', '-q', '-am', 'code 2');
    expect(id(dir)).toBe(`1.2.3+${git('rev-parse', 'HEAD').slice(0, 12)}`);
    expect(id(dir)).not.toBe(first);
  });

  it('uncommitted build inputs make it dirty; uncommitted docs/tests do not', async () => {
    const { dir, write } = await repo();
    const clean = id(dir);
    await write('src/README.md', '# changed\n');
    await write('src/b.test.ts', 'test\n');
    await write('notes.txt', 'x\n');
    expect(id(dir)).toBe(clean);
    await write('src/a.ts', 'export const a = 3;\n');
    expect(id(dir)).toMatch(new RegExp(`^${clean.replace(/[.+]/g, '\\$&')}\\.dirty-[0-9a-f]{8}$`));
    await write('vite.config.ts', 'export default {};\n');
    const dirtier = id(dir);
    expect(dirtier).not.toBe(clean);
    expect(id(dir)).toBe(dirtier);
  });

  it('PARALLAX_BUILD_ID overrides (validated)', async () => {
    const { dir } = await repo();
    expect(resolveBuildId(dir, { PARALLAX_BUILD_ID: '9.9.9+e2e' })).toBe('9.9.9+e2e');
    expect(() => resolveBuildId(dir, { PARALLAX_BUILD_ID: 'a b' })).toThrow();
  });
});
