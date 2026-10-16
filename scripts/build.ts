/**
 * `pnpm build` (CR-08, ADR-094): the whole build – `build:web` (Vite) and `build:server` (esbuild,
 * scripts/build-server.ts) – through the shared build path `buildUnderLock` (src/server/launcher/
 * build.ts) under ONE build lock of the checkout. A launcher, an E2E setup or a second
 * `pnpm build` of the same checkout waits for it, so `dist/` is never written by two builds at once.
 * The steps' own output is shown only when a step fails.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnderLock, readBundleBuildId } from '../src/server/launcher/build.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const result = await buildUnderLock({
  repoRoot,
  nodePath: process.execPath,
  env: process.env,
  onWaiting: () => {
    out('[build] another build of this checkout is running - waiting for it ...');
  },
  onStep: (step) => {
    out(`[build] ${step.script}`);
  },
});
if (result.ok) {
  out(`[build] done (build ${(await readBundleBuildId(repoRoot)) ?? 'unknown'})`);
} else {
  process.stderr.write(`[build] ${result.step} failed:\n${result.output}\n`);
  process.exitCode = 1;
}
