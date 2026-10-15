import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEV_WEB_PORT as SHARED_DEV_WEB_PORT } from './src/shared/http.ts';
import { DEV_WEB_PORT, devWebPort, insideDir, watchIgnores } from './repo.config.ts';

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
