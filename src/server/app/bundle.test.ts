/**
 * The server bundle (esbuild like scripts/build-server.ts: one ESM file, npm packages external)
 * loads the Agent SDK only for `--backend=sdk` (WP-20a gap 1, fixed in WP-20c): a static import of
 * an external package is hoisted to the top of the bundle and would load the SDK on every start.
 * WP-87 (E7): only a test build (`__PARALLAX_UPDATE_TEST__` true, build-server `--update-test`)
 * keeps the code that reads a local release server and test keys from the environment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SDK = '@anthropic-ai/claude-agent-sdk';
const UPDATE_TEST_DEFINE = '__PARALLAX_UPDATE_TEST__';

/** Bundles like scripts/build-server.ts (in memory) and returns the code. */
async function bundle(input: { entry: string } | { contents: string }, updateTest: boolean): Promise<string> {
  const result = await build({
    absWorkingDir: repoRoot,
    ...('entry' in input
      ? { entryPoints: [input.entry] }
      : { stdin: { contents: input.contents, resolveDir: repoRoot, loader: 'ts' as const } }),
    outfile: 'dist/bundle.js',
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    alias: { '@shared': path.join(repoRoot, 'src', 'shared') },
    tsconfig: 'src/server/tsconfig.json',
    define: { [UPDATE_TEST_DEFINE]: updateTest ? 'true' : 'false' },
    logLevel: 'silent',
  });
  return result.outputFiles.find((file) => file.path.endsWith('.js'))?.text ?? '';
}

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

  it('WP-87: normal bundles keep no update test switch; a test build keeps it', async () => {
    for (const entry of ['src/server/main.ts', 'src/server/launcher/main.ts', 'src/server/install/main.ts']) {
      expect(await bundle({ entry }, false), entry).not.toContain('PARALLAX_TEST_');
    }
    const caller = [
      "import { updateEndpoints } from './src/server/update/endpoints';",
      'export const endpoints = updateEndpoints();',
    ].join('\n');
    expect(await bundle({ contents: caller }, false)).not.toContain('PARALLAX_TEST_');
    expect(await bundle({ contents: caller }, true)).toContain('PARALLAX_TEST_UPDATE_BASE');
  }, 120_000);
});
