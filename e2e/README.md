# e2e – Playwright-Tests (WP-20)

E2E-Tests (`*.spec.ts`) mit `@playwright/test` gegen das installierte Microsoft Edge
(`channel: 'msedge'`, siehe `playwright.config.ts`). **Kein Browser-Download.** Die App läuft
dabei auf dem FakeBackend mit `PARALLAX_HOME=<tmp>` und `PARALLAX_PORT=0`.
