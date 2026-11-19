/**
 * WP-92 in Chrome against the built server:
 * - the zoom setting becomes the root font size; Ctrl+Plus/Minus and Ctrl+wheel change it instead of
 *   Chrome's page zoom (`devicePixelRatio` stays), Ctrl+0 goes back to 100 %; the server stores it
 *   and a reload starts at that size;
 * - at 150 %: a menu sits at its trigger, the sidebar is drawn at the zoom and its handle follows
 *   the pointer, the narrow layout counts layout px.
 * Own server.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { serverSettings } from './support/server';

test.use({ ownServer: 'zoom' });

function rootFontSize(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
}

function pixelRatio(page: Page): Promise<number> {
  return page.evaluate(() => window.devicePixelRatio);
}

test('zoom: the setting, Ctrl+Plus/Minus, Ctrl+wheel, Ctrl+0 and a reload', async ({ app, server, page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const ratio = await pixelRatio(page);
  expect(await rootFontSize(page)).toBe('16px');

  const settings = await app.openSettingsPage();
  const trigger = settings.locator('[data-setting="zoom"] [role="combobox"]');
  await expect(trigger).toHaveText('100 %');
  await trigger.click();
  await page.getByRole('option', { name: '150 %' }).click();
  await expect.poll(() => rootFontSize(page)).toBe('24px');
  await expect.poll(async () => (await serverSettings(server)).zoom).toBe(150);
  // The select is closed (its layer would take the Esc), then Esc closes the page.
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(settings).not.toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  await page.keyboard.press('Control+Minus');
  await expect.poll(() => rootFontSize(page)).toBe('20px');
  await page.keyboard.press('Control+Equal');
  await expect.poll(() => rootFontSize(page)).toBe('24px');
  await page.keyboard.press('Control+Minus');
  await expect.poll(async () => (await serverSettings(server)).zoom).toBe(125);

  // One notch down zooms out one step; Chrome itself does not zoom.
  await page.mouse.move(800, 450);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await expect.poll(() => rootFontSize(page)).toBe('17.6px');
  await expect.poll(async () => (await serverSettings(server)).zoom).toBe(110);
  expect(await pixelRatio(page)).toBe(ratio);

  // The settings show what the keys did.
  const again = await app.openSettingsPage();
  await expect(again.locator('[data-setting="zoom"] [role="combobox"]')).toHaveText('110 %');
  await page.keyboard.press('Escape');

  await page.reload();
  await app.waitConnected();
  expect(await rootFontSize(page)).toBe('17.6px');

  await page.keyboard.press('Control+Digit0');
  await expect.poll(() => rootFontSize(page)).toBe('16px');
  await expect.poll(async () => (await serverSettings(server)).zoom).toBe(100);
  expect(await pixelRatio(page)).toBe(ratio);
});

test('zoom 150 %: menu at its trigger, sidebar at the zoom, handle follows the pointer, narrow layout', async ({
  app,
  server,
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await app.newSession(await server.makeProject('zoom'));
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Equal');
  await expect.poll(() => rootFontSize(page)).toBe('24px');

  // A menu opens at its trigger (Radix positions it in the same coordinates).
  const button = app.settingsButton();
  const menu = await app.openSettings();
  const buttonBox = await button.boundingBox();
  const menuBox = await menu.boundingBox();
  if (buttonBox === null || menuBox === null) throw new Error('no boxes');
  const dx = Math.max(0, menuBox.x - (buttonBox.x + buttonBox.width), buttonBox.x - (menuBox.x + menuBox.width));
  const dy = Math.max(0, menuBox.y - (buttonBox.y + buttonBox.height), buttonBox.y - (menuBox.y + menuBox.height));
  expect(Math.max(dx, dy)).toBeLessThan(24);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // 288 layout px are drawn as 432 px; the handle follows the pointer (60 px → 40 layout px).
  const frame = page.locator('[data-slot="sidebar-frame"]');
  const aside = frame.locator('aside');
  const handle = page.locator('[data-slot="sidebar-splitter"]');
  const width = async () => (await aside.boundingBox())?.width ?? 0;
  expect(Math.round(await width())).toBe(432);
  const box = await handle.boundingBox();
  if (box === null) throw new Error('no handle');
  const x = box.x + box.width / 2;
  const y = box.y + 300;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round(await width())).toBe(492);
  await expect(handle).toHaveAttribute('aria-valuenow', '328');

  // 1300 px at 150 % are 867 layout px: narrow, the sidebar becomes the rail; at 100 % it is wide.
  await page.setViewportSize({ width: 1300, height: 900 });
  await expect(frame).toHaveAttribute('data-state', 'collapsed');
  await page.keyboard.press('Control+Digit0');
  await expect(frame).toHaveAttribute('data-state', 'expanded');
  await expect.poll(async () => Math.round(await width())).toBe(328);
});
