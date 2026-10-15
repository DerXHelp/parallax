/**
 * Playwright global setup (WP-20c): the E2E tests run against the built bundle (`dist/server.js`
 * + `dist/web`). Like the launcher, build only when `dist` is missing or its build id differs from
 * the checkout's (`checkBuild` + `resolveCheckoutBuildId`, src/server/launcher/build.ts); the build
 * runs the same two steps as `pnpm build`. `PARALLAX_E2E_SKIP_BUILD=1` skips the check.
 */
import { checkBuild, resolveCheckoutBuildId, runBuild } from '../src/server/launcher/build';
import { REPO_ROOT } from './support/paths';

export default async function globalSetup(): Promise<void> {
  if (process.env.PARALLAX_E2E_SKIP_BUILD === '1') return;
  const expected = await resolveCheckoutBuildId(REPO_ROOT);
  const state = await checkBuild({ repoRoot: REPO_ROOT, expected });
  if (state.upToDate) return;
  process.stdout.write(`[e2e] building dist/ (${state.reason}) …\n`);
  const result = await runBuild({
    repoRoot: REPO_ROOT,
    nodePath: process.execPath,
    env: process.env,
    onStep: (step) => {
      process.stdout.write(`[e2e]   ${step.script}\n`);
    },
  });
  if (!result.ok) throw new Error(`[e2e] ${result.step} failed:\n${result.output}`);
}
