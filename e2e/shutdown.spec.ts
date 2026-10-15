/**
 * "Server beenden" with confirmation (WP-21, Plan "Server-Betrieb"): the dialog names the working
 * and waiting sessions, "Cancel" keeps the server, "Stop server" → ack → WS close 4503 in every
 * window → "Parallax server stopped"; the process ends with 0, the lock file is gone and no child
 * process is left. Own server (the worker's server must survive).
 */
import { ParallaxApp } from './support/app';
import { startE2eServer, type E2eServer } from './support/server';
import { expect, test } from './support/fixtures';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop();
  own = null;
});

test('"Stop server…" asks first, then stops the server in every window', async ({ page, context }) => {
  own = await startE2eServer({ label: 'shutdown' });
  const app = await new ParallaxApp(page, own).open();
  const waiting = await app.newSession(await own.makeProject('waiting'));
  await waiting.send('fake:permission before shutdown');
  await waiting.armedCard('permission');
  const working = await app.newSession(await own.makeProject('working'));
  await working.send('fake:slow');
  await working.expectStatus('working');
  const second = await new ParallaxApp(await context.newPage(), own).open();

  // The confirmation names what is affected; "Cancel" keeps everything running.
  let menu = await app.openSettings();
  await menu.getByRole('menuitem', { name: 'Stop server…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Stop the Parallax server?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Working (1)');
  await expect(dialog).toContainText('Waiting for you (1)');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(app.connection()).toHaveAttribute('data-status', 'open');
  await expect(working.assistantText(/Line 3 of a slow answer/)).toBeVisible();

  menu = await app.openSettings();
  await menu.getByRole('menuitem', { name: 'Stop server…' }).click();
  dialog = page.getByRole('dialog', { name: 'Stop the Parallax server?' });
  await dialog.getByRole('button', { name: 'Stop server' }).click();

  await expect(page.getByRole('heading', { name: 'Parallax server stopped' })).toBeVisible();
  await expect(second.page.getByRole('heading', { name: 'Parallax server stopped' })).toBeVisible();
  await own.assertCleanExit();
});
