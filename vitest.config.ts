import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { repoAliases, worktreeGlobs } from './repo.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const exclude = [...configDefaults.exclude, ...worktreeGlobs, '**/dist/**', '**/.tsbuild/**'];

/**
 * Tests live next to the code as *.test.ts(x). Two projects:
 *  - node: src/server, src/shared, scripts, test (Node environment)
 *  - web:  src/web (happy-dom + React Testing Library)
 * Every run gets PARALLAX_HOME=<tmp> and PARALLAX_PORT=0 unless already set (test/setup).
 */
export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: repoAliases(repoRoot),
  },
  server: {
    watch: { ignored: [...worktreeGlobs] },
  },
  test: {
    globalSetup: ['test/setup/global.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/server/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'scripts/**/*.test.ts',
            'test/**/*.test.ts',
          ],
          exclude,
          setupFiles: ['test/setup/env.ts'],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['src/web/**/*.test.{ts,tsx}'],
          exclude,
          setupFiles: ['test/setup/env.ts', 'test/setup/web.ts'],
        },
      },
    ],
  },
});
