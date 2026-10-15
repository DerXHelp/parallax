/**
 * The server bundle (esbuild like scripts/build-server.ts: one ESM file, npm packages external)
 * loads the Agent SDK only for `--backend=sdk` (WP-20a gap 1, fixed in WP-20c): a static import of
 * an external package is hoisted to the top of the bundle and would load the SDK on every start.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SDK = '@anthropic-ai/claude-agent-sdk';

describe('server bundle', () => {
  it('imports the Agent SDK only dynamically', async () => {
    const result = await build({
      absWorkingDir: repoRoot,
      entryPoints: ['src/server/main.ts'],
      outfile: 'dist/server.js',
      write: false,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      alias: { '@shared': path.join(repoRoot, 'src', 'shared') },
      tsconfig: 'src/server/tsconfig.json',
      logLevel: 'silent',
    });
    const code = result.outputFiles.find((file) => file.path.endsWith('server.js'))?.text ?? '';
    expect(code).toContain(`import("${SDK}")`);
    expect(code).not.toMatch(new RegExp(`^import[^;]*from\\s*"${SDK.replace(/[/-]/g, '\\$&')}"`, 'm'));
    expect(code).not.toContain(`from "${SDK}"`);
  }, 60_000);
});
