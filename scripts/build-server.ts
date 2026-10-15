/**
 * Bundles the server into dist/server.js (ESM, Node >= 22).
 * npm packages stay external and are loaded from node_modules at runtime (pino transports,
 * the Agent SDK and native modules must not be bundled). Only own code and `@shared/*` are bundled.
 * The build id (same value as the web bundle, see resolveBuildId) is injected via `define`
 * (read by src/shared/build.ts) and stamped into the bundle's first line.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUILD_ID_DEFINE, repoAliases, resolveBuildId } from '../repo.config.ts';
import { PRODUCT_NAME } from '../src/shared/product.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aliases = repoAliases(repoRoot);
const sharedDir = aliases['@shared'];
if (sharedDir === undefined) {
  throw new Error('repoAliases() must define @shared');
}
const buildId = resolveBuildId(repoRoot);

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
  define: { [BUILD_ID_DEFINE]: JSON.stringify(buildId) },
  banner: { js: `// ${PRODUCT_NAME} server, build ${buildId}` },
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
});

const outputs = Object.keys(result.metafile.outputs);
process.stdout.write(`server bundle written: ${outputs.join(', ')} (build ${buildId})\n`);
