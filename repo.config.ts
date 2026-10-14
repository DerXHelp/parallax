/**
 * Shared repo settings for vite.config.ts, vitest.config.ts and scripts/build-server.ts,
 * so aliases, dev ports and ignore globs stay consistent. (eslint.config.js and the
 * tsconfig files repeat the alias / ignore lists because they cannot import TypeScript.)
 */
import path from 'node:path';

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
