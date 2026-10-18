/**
 * Phase-2 settings page (WP-38 over WP-31/WP-33; ADR-105/109/110/111), the first two tests on their
 * own server (the settings are host-wide):
 * - notifications per event: Windows notification off → only the in-app hint, no Web Notification;
 *   "Do not disturb" → neither Web Notification nor sound, the hint and "(n)" stay;
 * - idle sleep values survive a reload; the server section shows the actual port; autostart and
 *   "click opens the session" are disabled with the reason (fake server: no system integration);
 *   language and theme from the general section;
 * - R4W-01: an unsaved profile draft survives switching sections; Esc asks before closing.
 * Every change counts as saved only once the server has it (`serverSettings`, R4W-27) – the page
 * shows it optimistically before the ack.
 */
import type { Locator } from '@playwright/test';
import type { Settings } from '@shared/model';
import { ParallaxApp } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { recordNotifications, setPresence, tones, toasts } from './support/presence';
import { serverSettings, startE2eServer, type E2eServer } from './support/server';

test.use({ permissions: ['notifications'] });

/** First tones of the synthesized sounds (src/web/notifications/sounds.ts). */
const CHIME_HZ = 659.25;
const POP_HZ = 520;

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

/** Clicks `control` (a switch) unless it already shows `checked`; waits until it shows it. */
async function setSwitch(control: Locator, checked: boolean): Promise<void> {
  if ((await control.getAttribute('aria-checked')) !== String(checked)) await control.click();
  await expect(control).toHaveAttribute('aria-checked', String(checked));
}

/** Waits until the server has stored what `read` picks from its settings (not the optimistic page). */
async function expectStored<T>(
  server: E2eServer,
  read: (settings: Settings) => T,
  expected: T,
): Promise<void> {
  await expect
    .poll(async () => read(await serverSettings(server)), { message: 'stored by the server' })
    .toEqual(expected);
}

function frequencies(page: Parameters<typeof tones>[0]): Promise<(number | null)[]> {
  return tones(page).then((list) => list.map((tone) => tone.frequency));
}

test('notifications: Windows notification off → in-app hint only; "Do not disturb" → no toast, no sound', async ({
  page,
  context,
}) => {
  own = await startE2eServer({ label: 'settings-notify' });
  const server = own;
  await context.addInitScript(recordNotifications);
  const app = await new ParallaxApp(page, server).open();
  const session = await app.newSession(await server.makeProject('notify'));
  await session.send('hello settings');
  await expect(session.assistantText('Echo: hello settings')).toBeVisible();

  const settings = await app.openSettingsPage('notifications');
  // The Windows-notification switch (first column) of the event "Permission needed".
  await setSwitch(settings.locator('[data-event="permission"] td:first-of-type [role="switch"]'), false);
  await expectStored(server, (s) => s.notifications.events.permission.toast, false);
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
  // Positive control (R4W-27): the window does sound here – the hint plays its chime.
  await expect.poll(() => frequencies(page)).toContain(CHIME_HZ);
  await (await session.armedCard('permission')).locator('[data-action="allow-once"]').click();
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  // "Done" still has its Windows notification (only the permission's was switched off) and its pop.
  await expect
    .poll(async () => (await toasts(page)).map((toast) => toast.title))
    .toEqual(['Fake: hello settings – done']);
  await expect.poll(() => frequencies(page)).toContain(POP_HZ);

  // "Do not disturb": no Web Notification and no sound; the hint and the count stay.
  await setPresence(page, { focused: true, visible: true });
  const again = await app.openSettingsPage('notifications');
  await setSwitch(again.locator('[data-setting="doNotDisturb"] [role="switch"]'), true);
  await expectStored(server, (s) => s.notifications.doNotDisturb, true);
  await page.keyboard.press('Escape');
  await expect(again).toHaveCount(0);
  await setPresence(page, { focused: false, visible: false });
  const tonesBefore = (await tones(page)).length;
  await session.send('fake:question while not disturbed');
  await session.armedCard('question');
  await expect(app.notices().filter({ hasText: '– has a question' })).toBeVisible();
  await expect(page).toHaveTitle('(1) Parallax');
  // No fixed wait (R4W-27): the window decides toast and sound in the same step that shows the
  // hint (notifications/delivery.ts `deliver`) – once the hint is there, a missing toast or tone
  // stays missing.
  expect((await toasts(page)).map((toast) => toast.title)).toEqual(['Fake: hello settings – done']);
  expect((await tones(page)).length).toBe(tonesBefore);
});

test('idle sleep survives a reload; port hint; autostart/click-to-open disabled without system integration; language and theme', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'settings-page' });
  const server = own;
  const app = await new ParallaxApp(page, server).open();

  // Sessions: idle sleep on, 45 minutes (saved on Enter) – kept by the server over a reload.
  const sessions = await app.openSettingsPage('sessions');
  await setSwitch(sessions.locator('[data-setting="idleSleep"] [role="switch"]'), true);
  await expectStored(server, (s) => s.idleSleep.enabled, true);
  const minutes = sessions.locator('[data-setting="idleMinutes"] input');
  await expect(minutes).toHaveValue('30');
  await minutes.fill('45');
  await minutes.press('Enter');
  await expect(minutes).toHaveValue('45');
  await expectStored(server, (s) => s.idleSleep, { enabled: true, minutes: 45 });
  // Out of range: an error at the field, nothing saved.
  await minutes.fill('4');
  await minutes.press('Enter');
  await expect(sessions.locator('[data-setting="idleMinutes"] [role="alert"]')).toBeVisible();
  await expectStored(server, (s) => s.idleSleep.minutes, 45);
  await page.keyboard.press('Escape');
  await page.reload();
  await app.waitConnected();
  const reloaded = await app.openSettingsPage('sessions');
  await expect(reloaded.locator('[data-setting="idleMinutes"] input')).toHaveValue('45');
  await expect(reloaded.locator('[data-setting="idleSleep"] [role="switch"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Server: the actual port (HostState.port); autostart disabled with the reason.
  await reloaded.locator('[role="tab"][data-section="server"]').click();
  await expect(reloaded.locator('[data-setting="port"]')).toContainText(
    `Current port: ${String(server.port)}`,
  );
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
  await reloaded.locator('[data-setting="theme"] [role="radio"][value="light"]').click();
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await expectStored(server, (s) => s.theme, 'light');
  await reloaded.locator('[data-setting="language"] [role="radio"][value="de"]').click();
  await expect(reloaded.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expectStored(server, (s) => s.language, 'de');
  await page.keyboard.press('Escape');
  await page.reload();
  await app.waitConnected();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});

test('profile draft: survives switching sections; Esc asks – "Keep editing" returns to the field, "Discard and close" closes (R4W-01)', async ({
  app,
  page,
}) => {
  const settings = await app.openSettingsPage('profiles');
  const section = settings.locator('[data-slot="profiles-settings"]');
  await expect(section.locator('[data-profile-row]').first()).toBeVisible();
  const rowsBefore = await section.locator('[data-profile-row]').count();
  await section.locator('[data-action="profile-new"]').click();
  const editor = section.locator('[data-slot="profile-editor"][data-profile-id="new"]');
  await expect(editor).toBeVisible();
  await editor.locator('[data-action="env-add"]').click();
  const envRow = editor.locator('[data-env-row]').first();
  const key = envRow.locator('input[data-part="key"]');
  const value = envRow.locator('input[data-part="value"]');
  await key.fill('DRAFT_TOKEN');
  await value.fill('draft-secret');
  const profilesTab = settings.locator('[role="tab"][data-section="profiles"]');
  await expect(profilesTab).toHaveAttribute('data-unsaved', 'true');

  // Another section and back: the draft is kept (mounted, hidden), the secret still masked.
  await settings.locator('[role="tab"][data-section="general"]').click();
  await expect(editor).toBeHidden();
  await expect(profilesTab).toHaveAttribute('data-unsaved', 'true');
  await profilesTab.click();
  await expect(key).toHaveValue('DRAFT_TOKEN');
  await expect(value).toHaveValue('draft-secret');
  await expect(value).toHaveAttribute('type', 'password');

  // Esc in the field asks inline; the page stays; the harmless choice has the focus (R4W-24).
  await value.focus();
  await page.keyboard.press('Escape');
  const confirm = settings.locator('[data-slot="settings-close-confirm"]');
  await expect(confirm).toBeVisible();
  const keep = confirm.locator('[data-action="settings-keep-editing"]');
  await expect(keep).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(value).toBeFocused();
  await expect(value).toHaveValue('draft-secret');

  // Asked again, "Discard and close": the page closes, the focus goes back to the settings button.
  await page.keyboard.press('Escape');
  await confirm.locator('[data-action="settings-discard-close"]').click();
  await expect(settings).toHaveCount(0);
  await expect(app.settingsButton()).toBeFocused();
  // Nothing was saved; a new page starts without the draft.
  const reopened = await app.openSettingsPage('profiles');
  await expect(reopened.locator('[data-profile-row]')).toHaveCount(rowsBefore);
  await expect(reopened.locator('[data-slot="profile-editor"][data-profile-id="new"]')).toHaveCount(0);
  await expect(reopened.locator('[role="tab"][data-section="profiles"]')).not.toHaveAttribute(
    'data-unsaved',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(reopened).toHaveCount(0);
});
