/**
 * Shared repo settings for vite.config.ts, vitest.config.ts and scripts/build-server.ts,
 * so aliases, dev ports, ignore globs and the build id stay consistent. (eslint.config.js and the
 * tsconfig files repeat the alias / ignore lists because they cannot import TypeScript.)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Port of the dev server started by `pnpm dev:server` (see package.json --port). */
export const DEV_SERVER_PORT = 4712;

/** Port of the Vite dev server (proxies /api to DEV_SERVER_PORT). */
export const DEV_WEB_PORT = 5173;

/** Git worktrees of parallel work packages; never watched, tested, linted or bundled. */
export const worktreeGlobs = ['**/.worktrees/**', '**/.claude/worktrees/**'] as const;

/** Import aliases: `@shared/*` -> src/shared/*, `@web/*` -> src/web/* (web only). */
export function repoAliases(repoRoot: string): Record<string, string> {
  return {
    '@shared': path.join(repoRoot, 'src/shared'),
    '@web': path.join(repoRoot, 'src/web'),
  };
}

/** Build-time constant read by src/shared/build.ts (`define` in Vite and esbuild). */
export const BUILD_ID_DEFINE = '__PARALLAX_BUILD_ID__';

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

/**
 * Build id embedded by `pnpm build` into the web and the server bundle (A.2: a new build id makes
 * open windows reload). `PARALLAX_BUILD_ID` overrides it; otherwise
 * `<package.version>+<git short hash>`, plus `.dirty-<digest of the uncommitted changes>` when
 * the working tree is dirty. Deterministic, so the two separately built bundles get the same value.
 * Unbundled runs (dev server, tsx, Vitest) use 'dev' instead (src/shared/build.ts).
 */
export function resolveBuildId(repoRoot: string): string {
  const override = process.env.PARALLAX_BUILD_ID;
  if (override !== undefined && override !== '') return buildIdOverrideSchema.parse(override);

  const pkg = packageJsonSchema.parse(JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')));
  const head = git(repoRoot, ['rev-parse', '--short=12', 'HEAD']) ?? 'nogit';
  const status = git(repoRoot, ['status', '--porcelain']) ?? '';
  if (status === '') return `${pkg.version}+${head}`;

  const diff = git(repoRoot, ['diff', 'HEAD', '--no-ext-diff', '--no-color']) ?? '';
  const digest = createHash('sha256').update(status).update('\0').update(diff).digest('hex').slice(0, 8);
  return `${pkg.version}+${head}.dirty-${digest}`;
}
