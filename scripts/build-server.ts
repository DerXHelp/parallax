/**
 * Bundles the server into dist/server.js (ESM, Node >= 22).
 * npm packages stay external and are loaded from node_modules at runtime (pino transports,
 * the Agent SDK and native modules must not be bundled). Only own code and `@shared/*` are bundled.
 * The build id (same value as the web bundle, see resolveBuildId) is injected via `define`
 * (read by src/shared/build.ts) and stamped into the bundle's first line.
 *
 * CR-08 (ADR-092/094): runs under the build lock of the checkout (src/server/launcher/build.ts) –
 * unless its caller holds it already (`runBuild` of `pnpm build`, the launcher or the E2E setup
 * sets `BUILD_LOCK_HELD_ENV`). Run alone (`pnpm build:server`), it waits for another build.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUILD_ID_DEFINE, repoAliases, resolveBuildId } from '../repo.config.ts';
import {
  BUILD_LOCK_HELD_ENV,
  BUILD_LOCK_POLL_MS,
  BUILD_LOCK_WAIT_MS,
  acquireBuildLock,
  pollLock,
} from '../src/server/launcher/build.ts';
import { sleep } from '../src/server/lib/async.ts';
import { PRODUCT_NAME } from '../src/shared/product.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aliases = repoAliases(repoRoot);
const sharedDir = aliases['@shared'];
if (sharedDir === undefined) {
  throw new Error('repoAliases() must define @shared');
}

const lock =
  process.env[BUILD_LOCK_HELD_ENV] === '1'
    ? null
    : await pollLock(() => acquireBuildLock(repoRoot), {
        waitMs: BUILD_LOCK_WAIT_MS,
        pollMs: BUILD_LOCK_POLL_MS,
        sleep,
        now: () => Date.now(),
        onWaiting: () => {
          process.stdout.write('another build of this checkout is running - waiting for it ...\n');
        },
      });
if (process.env[BUILD_LOCK_HELD_ENV] !== '1' && lock === null) {
  throw new Error('another build of this checkout did not finish in time');
}

try {
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
} finally {
  await lock?.release();
}
