/**
 * Playwright global setup (WP-20c): the E2E tests run against the built bundle (`dist/server.js`
 * + `dist/web`). Like the launcher, build only when `dist` is missing or its build id differs from
 * the checkout's (`checkBuild` + `resolveCheckoutBuildId`, src/server/launcher/build.ts); the build
 * runs the same two steps as `pnpm build`. `PARALLAX_E2E_SKIP_BUILD=1` skips the check.
 *
 * WP22-07 (defense in depth): the runner and its workers never use an inherited PARALLAX_HOME –
 * `ensureTestEnv({ fresh: true })` (test/setup/home.ts) sets an own temp home and port 0 and drops
 * inherited server control variables before the workers start (they inherit process.env); the
 * servers of the tests get their own temp homes anyway (support/server.ts).
 */
import { rmSync } from 'node:fs';
import { checkBuild, resolveCheckoutBuildId, runBuild } from '../src/server/launcher/build';
import { ensureTestEnv } from '../test/setup/home';
import { REPO_ROOT } from './support/paths';

export default async function globalSetup(): Promise<() => void> {
  const created = ensureTestEnv(process.env, { fresh: true });
  const teardown = (): void => {
    if (created !== undefined)
      rmSync(created, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  if (process.env.PARALLAX_E2E_SKIP_BUILD === '1') return teardown;
  const expected = await resolveCheckoutBuildId(REPO_ROOT);
  const state = await checkBuild({ repoRoot: REPO_ROOT, expected });
  if (state.upToDate) return teardown;
  process.stdout.write(`[e2e] building dist/ (${state.reason}) …\n`);
  const result = await runBuild({
    repoRoot: REPO_ROOT,
    nodePath: process.execPath,
    env: process.env,
    onStep: (step) => {
      process.stdout.write(`[e2e]   ${step.script}\n`);
    },
  });
  if (!result.ok) {
    teardown();
    throw new Error(`[e2e] ${result.step} failed:\n${result.output}`);
  }
  return teardown;
}
