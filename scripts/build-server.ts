/**
 * Bundles the server into dist/server.js, the launcher into dist/launcher.js and the installer into
 * dist/install.js (ESM, Node >= 24.5; launcher and installer are what a release package starts,
 * WP-85/WP-86 - a checkout runs the launcher with tsx).
 * npm packages stay external and are loaded from node_modules at runtime (pino transports,
 * the Agent SDK and native modules must not be bundled). Only own code and `@shared/*` are bundled.
 * The build id (same value as the web bundle, see resolveBuildId) is injected via `define`
 * (read by src/shared/build.ts) and stamped into the bundle's first line.
 *
 * CR-08 (ADR-092/094): runs under the build lock of the checkout (src/server/launcher/build.ts) –
 * unless its caller holds it already (`runBuild` of `pnpm build`, the launcher or the E2E setup
 * sets `BUILD_LOCK_HELD_ENV`). Run alone (`pnpm build:server`), it waits for another build.
 *
 * WP-87 (E7): `--update-test --out-dir=<dir>` writes a test build (`__PARALLAX_UPDATE_TEST__` true:
 * local release server, test keys and registry from the environment, src/server/update/endpoints.ts)
 * for the update E2E. It never goes to `dist/` – release-pack copies all of `dist/`. Every other
 * build defines the switch as false, so esbuild drops the test branch.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
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
const UPDATE_TEST_DEFINE = '__PARALLAX_UPDATE_TEST__';
const argsSchema = z.array(z.union([z.literal('--update-test'), z.string().regex(/^--out-dir=.+$/u)])).max(2);
const args = argsSchema.parse(process.argv.slice(2));
const updateTest = args.includes('--update-test');
const outArg = args.find((arg) => arg.startsWith('--out-dir='))?.slice('--out-dir='.length);
const outDir = path.resolve(repoRoot, outArg ?? 'dist');
const isReleaseDist = path.relative(path.join(repoRoot, 'dist'), outDir) === '';
if (updateTest && (outArg === undefined || isReleaseDist)) {
  throw new Error('--update-test needs --out-dir=<dir> outside dist/ (release-pack copies dist/)');
}
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
  const outputs: string[] = [];
  for (const [entry, file, kind] of [
    ['src/server/main.ts', 'server.js', 'server'],
    ['src/server/launcher/main.ts', 'launcher.js', 'launcher'],
    ['src/server/install/main.ts', 'install.js', 'installer'],
  ] as const) {
    const result = await build({
      absWorkingDir: repoRoot,
      entryPoints: [entry],
      outfile: path.join(outDir, file),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      packages: 'external',
      // Only @shared is an alias for the server; @web must never be reachable from here.
      alias: { '@shared': sharedDir },
      tsconfig: 'src/server/tsconfig.json',
      define: {
        [BUILD_ID_DEFINE]: JSON.stringify(buildId),
        [UPDATE_TEST_DEFINE]: updateTest ? 'true' : 'false',
      },
      // The server banner is parsed by the launcher's build check (launcher/build.ts).
      banner: { js: `// ${PRODUCT_NAME} ${kind}, build ${buildId}` },
      sourcemap: true,
      legalComments: 'none',
      logLevel: 'info',
      metafile: true,
    });
    outputs.push(...Object.keys(result.metafile.outputs));
  }
  const kind = updateTest ? 'update test bundles' : 'server bundles';
  process.stdout.write(`${kind} written: ${outputs.join(', ')} (build ${buildId})\n`);
} finally {
  await lock?.release();
}
