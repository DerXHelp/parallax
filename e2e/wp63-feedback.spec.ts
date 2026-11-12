/**
 * WP-63 (user feedback 1) in the real layout:
 * - §1.3 "Remove from Parallax": the open session from the header menu (the view goes back to the
 *   overview), archived ones with "Clean up archive…"; the files stay on disk; still gone after a
 *   server restart;
 * - §1.5 compact transcript: a run of work steps is one line (open/close, error counter), a burst of
 *   pictures is a gallery that shows while the group is closed, the lightbox steps through it;
 *   "All steps" in the settings shows every row again;
 * - §1.2 a limit warning only moves the limit bar – no notice in the transcript.
 * Own server per test: the remove test needs an exact list and a restart.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { ParallaxApp, type SessionView } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { startE2eServer, type E2eServer } from './support/server';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

/** A new session whose first turn gave it the AI title "Fake: <prompt>". */
async function titledSession(app: ParallaxApp, server: E2eServer, name: string): Promise<SessionView> {
  const session = await app.newSession(await server.makeProject(name));
  await session.send(`hello ${name}`);
  await expect(session.header.locator('h1')).toHaveText(`Fake: hello ${name}`);
  return session;
}

test('remove: the open session from the header menu, archived ones with "Clean up archive"; gone after a restart, files kept', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'remove' });
  const app = await new ParallaxApp(page, own).open();
  const keep = await titledSession(app, own, 'keep');
  const oldOne = await titledSession(app, own, 'old-one');
  const oldTwo = await titledSession(app, own, 'old-two');
  const open = await titledSession(app, own, 'open');
  await app.rowAction(oldOne.key, 'archive');
  await app.rowAction(oldTwo.key, 'archive');
  await expect(app.row(oldTwo.key)).toHaveCount(0);

  // The open session: confirmation with the "files stay" text; the view goes back to the overview.
  await app.selectSession(open.key);
  await open.headerAction('remove');
  const dialog = page.locator('[data-slot="remove-session-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Fake: hello open');
  await expect(dialog).toContainText('claude --resume');
  await dialog.locator('[data-action="confirm-remove"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(app.row(open.key)).toHaveCount(0);
  await expect.poll(() => app.selectedSessionKey()).toBeNull();
  await expect(open.pane).toHaveCount(0);

  // The archive: select all → "Remove (2)".
  const toggle = page.locator('[data-slot="archive-toggle"]');
  await expect(toggle).toHaveText(/\(2\)$/);
  await toggle.click();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'archive');
  await page.locator('[data-action="archive-cleanup"]').click();
  const cleanup = page.locator('[data-slot="archive-cleanup-dialog"]');
  await expect(cleanup.locator('[data-cleanup-row]')).toHaveCount(2);
  const remove = cleanup.locator('[data-action="cleanup-remove"]');
  await expect(remove).toBeDisabled();
  await cleanup.getByRole('checkbox', { name: 'Select all' }).click();
  await expect(remove).toHaveText('Remove (2)');
  await remove.click();
  await expect(cleanup).toHaveCount(0);
  // The empty archive goes away; the list shows the one session left.
  await expect(toggle).toHaveCount(0);
  await expect(app.sidebar()).toHaveAttribute('data-view', 'flat');
  await expect.poll(() => app.rowKeys()).toEqual([keep.key]);

  // Nothing was deleted: the Parallax folders of the removed sessions are still there.
  const entries = await readdir(path.join(own.home, 'entries'));
  for (const session of [open, oldOne, oldTwo]) expect(entries).toContain(session.entryId);

  // A restart does not bring them back.
  await own.requestShutdown();
  await own.assertCleanExit();
  const second = await startE2eServer({ label: 'remove', reuse: own });
  own = second;
  const again = await new ParallaxApp(page, second).open();
  await expect(again.row(keep.key)).toBeVisible();
  expect(await again.rowKeys()).toEqual([keep.key]);
  await expect(page.locator('[data-slot="archive-toggle"]')).toHaveCount(0);
});

test('compact transcript: step groups open and close, the gallery shows while closed, "All steps" in the settings', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'compact' });
  const app = await new ParallaxApp(page, own).open();
  const session = await app.newSession(await own.makeProject('compact'));

  // Two runs of Bash steps around one sentence: two closed group lines, the first with one error.
  await session.send('fake:steps');
  await expect(session.assistantText('All steps are done')).toBeVisible();
  await session.expectStatus('idle');
  await expect(session.assistantText('Halfway there')).toBeVisible();
  const groups = session.stepGroups();
  await expect(groups).toHaveCount(2);
  // By its key, not its position: the list is virtualized.
  const firstKey = await groups.first().getAttribute('data-group');
  const first = session.transcript.locator(`[data-slot="step-group"][data-group="${firstKey ?? ''}"]`);
  await expect(first).toHaveAttribute('data-state', 'closed');
  await expect(first.locator('[data-action="toggle-group"]')).toContainText('6 steps');
  await expect(first.locator('[data-slot="group-errors"]')).toHaveText('1 error');
  await expect(groups.nth(1).locator('[data-slot="group-errors"]')).toHaveCount(0);
  await expect(session.toolCall('Bash')).toHaveCount(0);

  // Opening keeps the group line in place (the list does not follow the end and push it away).
  const toggle = first.locator('[data-action="toggle-group"]');
  const before = await toggle.boundingBox();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(session.toolCall('Bash')).toHaveCount(6);
  await expect(session.toolCall('Bash').filter({ hasText: 'pnpm test --run src/a.test.ts' })).toHaveCount(2);
  expect((await toggle.boundingBox())?.y).toBe(before?.y);
  await toggle.click();
  await expect(first).toHaveAttribute('data-state', 'closed');
  await expect(session.toolCall('Bash')).toHaveCount(0);

  // A burst of four screenshots: one gallery under the closed group line; ← → in the lightbox.
  await session.send('fake:images');
  await expect(session.assistantText('The four screenshots')).toBeVisible();
  const imageGroup = session.stepGroups().last();
  await expect(imageGroup).toHaveAttribute('data-state', 'closed');
  const thumbs = imageGroup.locator('[data-slot="image-gallery"] [data-slot="image-thumb"]');
  await expect(thumbs).toHaveCount(4);
  await expect(thumbs.first()).toHaveAccessibleName('Enlarge image shot-1.png');
  await thumbs.first().click();
  const lightbox = page.locator('[data-slot="lightbox"]');
  await expect(lightbox).toHaveAccessibleName('Image: shot-1.png');
  await expect(lightbox.locator('[data-slot="lightbox-position"]')).toHaveText('Image 1 of 4');
  await lightbox.locator('[data-action="lightbox-next"]').click();
  await expect(lightbox).toHaveAccessibleName('Image: shot-2.png');
  await page.keyboard.press('ArrowRight');
  await expect(lightbox.locator('[data-slot="lightbox-position"]')).toHaveText('Image 3 of 4');
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);

  // §1.2: the weekly warning moves the limit bar only.
  await session.send('fake:limit-warning');
  await expect(session.assistantText('The weekly limit is at 81 %.')).toBeVisible();
  await expect(
    page.locator('[data-slot="account-limits"] [data-limit="seven_day"] [role="meter"]'),
  ).toHaveAttribute('aria-valuenow', '81');
  // No limit notice of any kind in the transcript (only "Usage limit reached" would show).
  await expect(session.transcript.getByText(/usage limit|% used/i)).toHaveCount(0);

  // Settings → General → "All steps": every step is a row again, the pictures one gallery row.
  const settings = await app.openSettingsPage('general');
  await chooseRadio(settings, 'All steps');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(session.stepGroups()).toHaveCount(0);
  await expect(session.transcript.locator('[data-row="gallery"] [data-slot="image-thumb"]')).toHaveCount(4);
  // The first steps at the top of the (virtualized) list are rows of their own again.
  await session.list().evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(
    session.toolCall('Bash').filter({ hasText: 'pnpm install --frozen-lockfile' }).first(),
  ).toBeVisible();
  await expect(session.stepGroups()).toHaveCount(0);
});

async function chooseRadio(scope: Locator, name: string): Promise<void> {
  const radio = scope.getByRole('radio', { name });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}
