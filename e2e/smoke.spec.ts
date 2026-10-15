/**
 * Smoke of language (en/de) and theme (dark/light) with a screenshot each (Playwright artifacts
 * in test-results/, git-ignored). The settings live on the server (settings.json) and reach every
 * window – so this test has its own server, the worker's server keeps English/dark.
 */
import type { Page, TestInfo } from '@playwright/test';
import { ParallaxApp } from './support/app';
import { startE2eServer, type E2eServer } from './support/server';
import { expect, test } from './support/fixtures';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop();
  own = null;
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function choose(app: ParallaxApp, item: string): Promise<void> {
  const menu = await app.openSettings();
  await menu.getByRole('menuitemradio', { name: item }).click();
  await expect(menu).toHaveCount(0);
}

test('language en/de and theme dark/light (screenshots)', async ({ page }, testInfo) => {
  own = await startE2eServer({ label: 'smoke' });
  const app = await new ParallaxApp(page, own).open();
  const html = page.locator('html');
  const session = await app.newSession(await own.makeProject('smoke'));
  await session.send('fake:question for the screenshot');
  const card = await session.armedCard('question');

  // Default: English, dark (ADR-007).
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(card).toContainText('Claude has a question');
  await shot(page, testInfo, 'en-dark');

  await choose(app, 'Light');
  await expect(html).not.toHaveClass(/\bdark\b/);
  await shot(page, testInfo, 'en-light');

  await choose(app, 'Deutsch');
  await expect(card).toContainText('Claude hat eine Frage');
  await expect(page.locator('[data-action="new-session"]')).toHaveAccessibleName('Neue Session');
  await expect(session.composer).toHaveAccessibleName('Nachricht an Claude');
  await shot(page, testInfo, 'de-light');

  await choose(app, 'Dunkel');
  await expect(html).toHaveClass(/\bdark\b/);
  await shot(page, testInfo, 'de-dark');

  // Persisted by the server: a reload (and every other window) keeps German + dark.
  await page.reload();
  await app.waitConnected();
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(app.session(session.key).card).toContainText('Claude hat eine Frage');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});
