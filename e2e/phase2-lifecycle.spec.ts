/**
 * Phase-2 lifecycle (WP-31/WP-34 over WP-35/WP-37; ADR-104/107):
 * - an earlier conversation (after `/clear`) is opened again in the same entry and continued;
 * - external console with the fake console (1.5 s "running"): open → `external` + banner + read-only
 *   composer + `handoff` line → after the console ended the engine takes the session back on its
 *   own, imports the turn made there (`handoff` "returned"), the next prompt runs;
 * - a server restart on the same PARALLAX_HOME (like recovery.spec.ts): the session is dormant, a
 *   prompt resumes it with the same (fake) Claude session id.
 */
import { ParallaxApp, type SessionView } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { startE2eServer, type E2eServer } from './support/server';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

/** The Claude session id from "Session info…" of the header menu. */
async function sessionIdOf(session: SessionView): Promise<string> {
  await (await session.headerMenu()).locator('[data-action="sessionInfo"]').click();
  const info = session.page.locator('[data-slot="session-info"]');
  await expect(info).toBeVisible();
  const text = (await info.textContent()) ?? '';
  await session.page.keyboard.press('Escape');
  await expect(info).toHaveCount(0);
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(text)?.[0];
  if (id === undefined) throw new Error(`no session id in: ${text}`);
  return id;
}

test('earlier conversation: after /clear it opens again in the same entry and continues', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('conversations'));
  await session.send('hello before the clear');
  await expect(session.assistantText('Echo: hello before the clear')).toBeVisible();
  const before = await sessionIdOf(session);
  await session.composer.fill('/clear');
  await session.composer.press('Escape');
  await session.composer.press('Enter');
  await expect(session.assistantText('Echo: hello before the clear')).toHaveCount(0);
  await session.send('hello after the clear');
  await expect(session.assistantText('Echo: hello after the clear')).toBeVisible();
  expect(await sessionIdOf(session)).not.toBe(before);

  await (await session.headerMenu()).locator('[data-action="conversations"]').click();
  const dialog = page.locator('[data-slot="conversations-dialog"]');
  await expect(dialog).toBeVisible();
  const earlier = dialog.locator('[data-conversation]').filter({ hasText: 'Cleared (/clear)' });
  await expect(earlier).toHaveCount(1);
  await earlier.getByRole('button', { name: 'Open' }).click();
  await expect(dialog).toHaveCount(0);

  // The earlier conversation is current again (its log end), the later one is in the list now.
  await expect(session.assistantText('Echo: hello before the clear')).toBeVisible();
  await expect(session.assistantText('Echo: hello after the clear')).toHaveCount(0);
  expect(await app.selectedSessionKey()).toBe(session.key);
  await session.send('continue the earlier one');
  await expect(session.assistantText('Echo: continue the earlier one')).toBeVisible();
  expect(await sessionIdOf(session)).toBe(before);
  await (await session.headerMenu()).locator('[data-action="conversations"]').click();
  await expect(
    dialog.locator('[data-conversation]').filter({ hasText: 'Switched to another conversation' }),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('external console (fake): open → external + banner → back on its own with the console turn; the next prompt runs', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('console'));
  await session.send('hello before the console');
  await expect(session.assistantText('Echo: hello before the console')).toBeVisible();
  await session.expectStatus('idle');

  await (await session.headerMenu()).locator('[data-action="openExternal"]').click();
  await session.expectStatus('external');
  const banner = session.pane.locator('[data-slot="pane-external"]');
  await expect(banner).toBeVisible();
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'disabled');
  await expect(session.transcript.locator('[data-slot="handoff-external"]')).toBeVisible();

  // The fake console "runs" 1.5 s; the engine checks every 5 s and takes the session back.
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  const returned = session.transcript.locator('[data-slot="handoff-returned"]');
  await expect(returned).toBeVisible();
  await expect(returned).toContainText('Back from the console');
  // The turn made in the console was imported.
  await expect(session.userMessages().filter({ hasText: 'Hello from the external console' })).toBeVisible();
  await expect(session.assistantText('Fake console: Hello from the external console')).toBeVisible();
  await session.expectStatus('sleeping');

  await session.send('after the console');
  await expect(session.assistantText('Echo: after the console')).toBeVisible();
  await session.expectStatus('idle');
});

test('server restart on the same home: the session is dormant, a prompt resumes it (same session id)', async ({
  page,
}) => {
  const first = await startE2eServer({ label: 'restart' });
  own = first;
  const app = await new ParallaxApp(page, first).open();
  const session = await app.newSession(await first.makeProject('restart'));
  await session.send('hello before the restart');
  await expect(session.assistantText('Echo: hello before the restart')).toBeVisible();
  const id = await sessionIdOf(session);

  await first.requestShutdown();
  await first.assertCleanExit();
  await expect(page.getByRole('heading', { name: 'Parallax server stopped' })).toBeVisible();

  const second = await startE2eServer({ label: 'restart', reuse: first });
  own = second;
  const again = await new ParallaxApp(page, second).open(`session=${session.key}`);
  const view = again.session(session.key);
  await expect(view.pane).toBeVisible();
  await view.expectStatus('sleeping');
  await expect(view.assistantText('Echo: hello before the restart')).toBeVisible();
  await view.send('hello after the restart');
  await expect(view.assistantText('Echo: hello after the restart')).toBeVisible();
  await view.expectStatus('idle');
  expect(await sessionIdOf(view)).toBe(id);
});
