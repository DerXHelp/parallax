import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests (WP-20c) in the installed Microsoft Edge (channel 'msedge', headless) against the real
 * server bundle `dist/server.js` with the FakeBackend – no browser download, no live `claude`.
 * - globalSetup builds `dist/` when it is missing or stale (build id, like the launcher).
 * - Every worker starts its own server (temp PARALLAX_HOME, port 0, e2e/support/server.ts); tests
 *   that end a server start their own. Teardown stops it with `server.shutdown` and checks that no
 *   child process is left.
 * - Artifacts (screenshots, traces) go to test-results/ (git-ignored).
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  // One server + one Edge per worker; more workers mostly add CPU contention on a dev machine.
  workers: 3,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'msedge',
      use: { ...devices['Desktop Edge'], channel: 'msedge', headless: true },
    },
  ],
});
