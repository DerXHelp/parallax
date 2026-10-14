/**
 * Bundles the server into dist/server.js (ESM, Node >= 22).
 * npm packages stay external and are loaded from node_modules at runtime (pino transports,
 * the Agent SDK and native modules must not be bundled). Only own code and `@shared/*` are bundled.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { repoAliases } from '../repo.config.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aliases = repoAliases(repoRoot);
const sharedDir = aliases['@shared'];
if (sharedDir === undefined) {
  throw new Error('repoAliases() must define @shared');
}

const result = await build({
  absWorkingDir: repoRoot,
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  // Only @shared is an alias for the server; @web must never be reachable from here.
  alias: { '@shared': sharedDir },
  tsconfig: 'src/server/tsconfig.json',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
});

const outputs = Object.keys(result.metafile.outputs);
process.stdout.write(`server bundle written: ${outputs.join(', ')}\n`);
