/**
 * Phase-3 verification "shell" (WP-60 E2E 9 and 10; WP-52/58):
 * 9. narrow window – at 1000 px the side panel lies over the transcript (session area < 1100 px),
 *    at 800 px the sidebar is collapsed to its rail as well; the session stays usable;
 * 10. errors – `fake:writes-lost` shows the lost writes of the session's end as an error row; a lazy
 *    slot whose chunk cannot be loaded (route blocked) shows the SlotBoundary card while the rest
 *    of the app keeps working.
 * Own server.
 */
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'p3shell' });

test('narrow window: 1000 px – panel over the transcript; 800 px – sidebar collapsed too; still usable', async ({
  app,
  server,
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const session = await app.newSession(await server.makeProject('narrow'));
  await session.send('hello narrow');
  await expect(session.assistantText('Echo: hello narrow')).toBeVisible();
  const sidebar = page.locator('[data-slot="sidebar-frame"]');
  const panel = await session.openPanel('files');
  await expect(panel).toHaveAttribute('data-mode', 'inline');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');

  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(panel).toHaveAttribute('data-mode', 'overlay');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
  const over = async () => {
    const panelBox = await panel.boundingBox();
    const transcriptBox = await session.transcript.boundingBox();
    return panelBox !== null && transcriptBox !== null && panelBox.x < transcriptBox.x + transcriptBox.width;
  };
  expect(await over()).toBe(true);

  await page.setViewportSize({ width: 800, height: 800 });
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  await expect(page.locator('[data-slot="sidebar-rail"]')).toBeVisible();
  await expect(panel).toHaveAttribute('data-mode', 'overlay');
  expect(await over()).toBe(true);

  // Still usable: the panel closes with its header button, the session answers.
  await session.panelButton('files').click();
  await expect(session.sidePanel).toHaveCount(0);
  await session.send('still usable');
  await expect(session.assistantText('Echo: still usable')).toBeVisible();
});

test('fake:writes-lost: the lost writes at the end of the session show as an error row', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('writes-lost'));
  await session.send('fake:writes-lost');
  await expect(session.assistantText('Fake: the disk is full')).toBeVisible();
  await session.expectStatus('idle');
  // The graceful end (put to sleep): the CLI reports the lost writes before its exit.
  await session.headerAction('sleep');
  const row = session.transcript
    .locator('[data-tone="error"]')
    .filter({ hasText: 'Claude Code could not save everything (disk full)' });
  await expect(row).toBeVisible();
});

test('a lazy slot whose chunk cannot be loaded shows the SlotBoundary card; the rest keeps working', async ({
  app,
  server,
  page,
}) => {
  const blocked: string[] = [];
  await page.route(/\/assets\/FilesPanel-[\w-]+\.js$/, async (route) => {
    blocked.push(route.request().url());
    await route.abort();
  });
  const session = await app.newSession(await server.makeProject('slot-error'));
  await session.send('hello slots');
  await expect(session.assistantText('Echo: hello slots')).toBeVisible();

  await session.panelButton('files').click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'files');
  const card = session.sidePanel.locator('[data-slot="slot-error"]');
  await expect(card).toHaveAttribute('data-error-kind', 'chunk');
  await expect(card).toContainText('This area could not be loaded');
  expect(blocked.length).toBeGreaterThan(0);

  // The rest keeps working: another tab of the panel, the transcript, the composer.
  await session.openPanel('tasks');
  await expect(session.sidePanel.locator('[data-slot="tasks-panel"]')).toBeVisible();
  await session.panelButton('tasks').click();
  await expect(session.sidePanel).toHaveCount(0);
  await session.send('still working');
  await expect(session.assistantText('Echo: still working')).toBeVisible();
});
