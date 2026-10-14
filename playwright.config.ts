import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests (WP-20) against the installed Microsoft Edge (channel 'msedge').
 * No browser download: Playwright browsers are never installed for this repo.
 * WP-20 adds the webServer (FakeBackend, PARALLAX_HOME=<tmp>, PARALLAX_PORT=0).
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'msedge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
});
