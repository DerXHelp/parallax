/**
 * Shared repo settings for vite.config.ts, vitest.config.ts and scripts/build-server.ts,
 * so aliases, dev ports, ignore lists and the build id stay consistent. (eslint.config.js and the
 * tsconfig files repeat the alias / ignore lists because they cannot import TypeScript.)
 * Local imports carry the `.ts` extension and must be import-free modules (Vite's native config
 * loader warns about extensionless imports inside imported files).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DEV_WEB_PORT } from './src/shared/devPorts.ts';

/** Port of the dev server started by `pnpm dev:server` (see package.json --port). */
export const DEV_SERVER_PORT = 4712;

/** Default port of the Vite dev server (proxies /api to DEV_SERVER_PORT); source: src/shared/devPorts.ts. */
export { DEV_WEB_PORT };

/** Env override of the Vite port, so several worktrees can run their playground side by side. */
export const DEV_WEB_PORT_ENV = 'PARALLAX_DEV_WEB_PORT';

const portOverrideSchema = z.coerce.number().int().min(1024).max(65535);

/**
 * Port of the Vite dev server: `PARALLAX_DEV_WEB_PORT` if set (e.g. 5175 in `.worktrees/wp-15`),
 * otherwise DEV_WEB_PORT. Only the default port works together with the dev server's API
 * (`--dev` allows the Origin `http://127.0.0.1:5173` only); other ports are for the playground,
 * which runs without a server.
 */
export function devWebPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEV_WEB_PORT_ENV];
  if (raw === undefined || raw === '') return DEV_WEB_PORT;
  const parsed = portOverrideSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`${DEV_WEB_PORT_ENV} must be a port between 1024 and 65535, got "${raw}"`);
  return parsed.data;
}

/**
 * Git worktrees of parallel work packages, as globs relative to the repo root. Only for
 * root-relative matching (Vitest `test.exclude`); never for file watchers (see watchIgnores).
 */
export const worktreeGlobs = ['**/.worktrees/**', '**/.claude/worktrees/**'] as const;

/** Directories below the repo root that no file watcher of this checkout may see. */
export const WATCH_IGNORED_DIRS = [
  '.worktrees',
  '.claude/worktrees',
  'dist',
  '.tsbuild',
  'coverage',
] as const;

/** True for `dir` itself and every path inside it (case-insensitive on Windows via path.relative). */
export function insideDir(dir: string): (file: string) => boolean {
  const root = path.resolve(dir);
  return (file) => {
    const rel = path.relative(root, path.resolve(file));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
}

/**
 * File-watcher ignores anchored at THIS checkout (R1W-01, ADR-030). Vite and Vitest hand them to chokidar,
 * which tests absolute paths: a relative glob like `**\/.worktrees/**` would also hide every file
 * of a checkout that itself lives in `.worktrees/<wp>` (no HMR, no `vitest --watch` there).
 */
export function watchIgnores(repoRoot: string): ((file: string) => boolean)[] {
  return WATCH_IGNORED_DIRS.map((dir) => insideDir(path.join(repoRoot, dir)));
}

/** Import aliases: `@shared/*` -> src/shared/*, `@web/*` -> src/web/* (web only). */
export function repoAliases(repoRoot: string): Record<string, string> {
  return {
    '@shared': path.join(repoRoot, 'src/shared'),
    '@web': path.join(repoRoot, 'src/web'),
  };
}

/** Build-time constant read by src/shared/build.ts (`define` in Vite and esbuild). */
export const BUILD_ID_DEFINE = '__PARALLAX_BUILD_ID__';

/**
 * Paths whose changes can change a bundle (ADR-036, ADR-065): sources, scripts, configs, lockfile
 * – without docs (`*.md`, also the READMEs inside src/) and tests/snapshots, which never reach a
 * bundle. Git pathspecs relative to the repo root.
 */
export const BUILD_INPUT_PATHSPECS = [
  'src',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  ':(glob)*.config.ts',
  ':(glob)tsconfig*.json',
  ':(exclude,glob)**/*.md',
  ':(exclude,glob)**/*.test.ts',
  ':(exclude,glob)**/*.test.tsx',
  ':(exclude,glob)**/__snapshots__/**',
] as const;

/** `dist/web/build.json` = `{"buildId": …}` (vite.config.ts; read by src/server/app/webSnapshot.ts). */
export const WEB_BUILD_INFO_FILE = 'build.json';

const buildIdOverrideSchema = z.string().regex(/^[0-9A-Za-z.+_-]{1,100}$/);
const packageJsonSchema = z.looseObject({ version: z.string().min(1) });

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/** Length of the commit part of a build id (`%H` cut to 12 hex – deterministic, unlike `%h`). */
const COMMIT_CHARS = 12;

/**
 * Build id embedded by `pnpm build` into the web and the server bundle (A.2: a new build id makes
 * open windows reload). `PARALLAX_BUILD_ID` overrides it; otherwise
 * `<package.version>+<last commit that changed a build input>` (R3-13, ADR-065: a docs-only or
 * test-only commit keeps the id, so it forces no rebuild), plus `.dirty-<digest of the uncommitted
 * changes>` when a build input (BUILD_INPUT_PATHSPECS) is changed or untracked. Git's default
 * history simplification makes that commit's build inputs identical to HEAD's. Deterministic, so
 * the two separately built bundles get the same value. Unbundled runs (dev server, tsx, Vitest) use
 * 'dev' instead (src/shared/build.ts).
 */
export function resolveBuildId(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PARALLAX_BUILD_ID;
  if (override !== undefined && override !== '') return buildIdOverrideSchema.parse(override);

  const pkg = packageJsonSchema.parse(JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')));
  const lastInput = git(repoRoot, ['log', '-1', '--format=%H', '--', ...BUILD_INPUT_PATHSPECS]) ?? '';
  // No commit touched a build input (fresh repo): HEAD; no git at all: 'nogit'.
  const commit =
    (lastInput !== '' ? lastInput : git(repoRoot, ['rev-parse', 'HEAD']))?.slice(0, COMMIT_CHARS) ?? 'nogit';
  const status = git(repoRoot, ['status', '--porcelain', '--', ...BUILD_INPUT_PATHSPECS]) ?? '';
  if (status === '') return `${pkg.version}+${commit}`;

  const diff =
    git(repoRoot, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--', ...BUILD_INPUT_PATHSPECS]) ?? '';
  const digest = createHash('sha256').update(status).update('\0').update(diff).digest('hex').slice(0, 8);
  return `${pkg.version}+${commit}.dirty-${digest}`;
}
