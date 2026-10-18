/**
 * Phase-2 settings page (WP-38 over WP-31/WP-33; ADR-105/109/110/111), each test on its own server
 * (the settings are host-wide):
 * - notifications per event: Windows notification off → only the in-app hint, no Web Notification;
 *   "Do not disturb" → neither Web Notification nor sound, the hint and "(n)" stay;
 * - idle sleep values survive a reload; the server section shows the actual port; autostart and
 *   "click opens the session" are disabled with the reason (fake server: no system integration);
 *   language and theme from the general section.
 */
import type { Locator } from '@playwright/test';
import { ParallaxApp } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { recordNotifications, setPresence, tones, toasts } from './support/presence';
import { startE2eServer, type E2eServer } from './support/server';

test.use({ permissions: ['notifications'] });

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

/** A switch of the settings page, by its accessible name; waits until it shows `checked`. */
async function setSwitch(page: Locator, name: string, checked: boolean): Promise<void> {
  const control = page.getByRole('switch', { name });
  if ((await control.getAttribute('aria-checked')) !== String(checked)) await control.click();
  await expect(control).toHaveAttribute('aria-checked', String(checked));
}

test('notifications: Windows notification off → in-app hint only; "Do not disturb" → no toast, no sound', async ({
  page,
  context,
}) => {
  own = await startE2eServer({ label: 'settings-notify' });
  await context.addInitScript(recordNotifications);
  const app = await new ParallaxApp(page, own).open();
  const session = await app.newSession(await own.makeProject('notify'));
  await session.send('hello settings');
  await expect(session.assistantText('Echo: hello settings')).toBeVisible();

  const settings = await app.openSettingsPage('notifications');
  await setSwitch(settings, 'Windows notification: Permission needed', false);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  // In the background: the permission comes as hint in the window, not as Web Notification.
  await setPresence(page, { focused: false, visible: false });
  await session.send('fake:permission without a toast');
  await session.armedCard('permission');
  const hint = app.notices().filter({ hasText: '– needs permission' });
  await expect(hint).toBeVisible();
  await expect(page).toHaveTitle('(1) Parallax');
  expect(await toasts(page)).toEqual([]);
  await (await session.armedCard('permission')).locator('[data-action="allow-once"]').click();
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  // "Done" still has its Windows notification (only the permission's was switched off).
  await expect
    .poll(async () => (await toasts(page)).map((toast) => toast.title))
    .toEqual(['Fake: hello settings – done']);

  // "Do not disturb": no Web Notification and no sound; the hint and the count stay.
  await setPresence(page, { focused: true, visible: true });
  const again = await app.openSettingsPage('notifications');
  await setSwitch(again, 'Do not disturb', true);
  await page.keyboard.press('Escape');
  await expect(again).toHaveCount(0);
  await setPresence(page, { focused: false, visible: false });
  const tonesBefore = (await tones(page)).length;
  await session.send('fake:question while not disturbed');
  await session.armedCard('question');
  await expect(app.notices().filter({ hasText: '– has a question' })).toBeVisible();
  await expect(page).toHaveTitle('(1) Parallax');
  await page.waitForTimeout(1000);
  expect((await toasts(page)).map((toast) => toast.title)).toEqual(['Fake: hello settings – done']);
  expect((await tones(page)).length).toBe(tonesBefore);
});

test('idle sleep survives a reload; port hint; autostart/click-to-open disabled without system integration; language and theme', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'settings-page' });
  const app = await new ParallaxApp(page, own).open();

  // Sessions: idle sleep on, 45 minutes (saved on Enter) – kept by the server over a reload.
  const sessions = await app.openSettingsPage('sessions');
  await setSwitch(sessions, 'Put idle sessions to sleep', true);
  const minutes = sessions.locator('[data-setting="idleMinutes"] input');
  await expect(minutes).toHaveValue('30');
  await minutes.fill('45');
  await minutes.press('Enter');
  await expect(minutes).toHaveValue('45');
  // Out of range: an error at the field, nothing saved.
  await minutes.fill('4');
  await minutes.press('Enter');
  await expect(sessions.locator('[data-setting="idleMinutes"] [role="alert"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await app.waitConnected();
  const reloaded = await app.openSettingsPage('sessions');
  await expect(reloaded.locator('[data-setting="idleMinutes"] input')).toHaveValue('45');
  await expect(reloaded.getByRole('switch', { name: 'Put idle sessions to sleep' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Server: the actual port (HostState.port); autostart disabled with the reason.
  await reloaded.locator('[role="tab"][data-section="server"]').click();
  await expect(reloaded.locator('[data-setting="port"]')).toContainText(`Current port: ${String(own.port)}`);
  await expect(reloaded.locator('[data-setting="port"] input')).toHaveAttribute(
    'placeholder',
    '4711 (default)',
  );
  const autostart = reloaded.locator('[data-setting="autostart"]');
  await expect(autostart.getByRole('switch')).toBeDisabled();
  await expect(autostart).toContainText('Only available for the installed Parallax server');
  await expect(reloaded.locator('[data-setting="openWindow"]').getByRole('switch')).toBeDisabled();
  // Notifications: "click opens the session" (protocol handler) as well.
  await reloaded.locator('[role="tab"][data-section="notifications"]').click();
  const openOnClick = reloaded.locator('[data-setting="openOnClick"]');
  await expect(openOnClick.getByRole('switch')).toBeDisabled();
  await expect(openOnClick).toContainText('Only available for the installed Parallax server');

  // General: language and theme as in the menu.
  await reloaded.locator('[role="tab"][data-section="general"]').click();
  await reloaded.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await reloaded.getByRole('radio', { name: 'Deutsch' }).click();
  await expect(reloaded.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await page.keyboard.press('Escape');
  await page.reload();
  await app.waitConnected();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});
