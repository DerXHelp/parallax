/**
 * WP-117 (Ausbau 1): the overview of the sidebar (WP-115 on the server of WP-112) with the FakeBackend:
 * - the text filter (folder) keeps only the matching row; no match → hint with "Reset filter";
 * - "Mark as unread" on the shown session (header menu) and on another one (row menu): the status
 *   filter "Unread" lists both – the shown one stays unread while the window keeps showing it;
 *   "Mark as read" takes one out; switching back to the shown session reads it;
 * - "Mute notifications" in the context menu of a project header (grouped by project): bell symbol at
 *   the header, saved in `notifications.mutedProjects`; a question in the muted project brings no
 *   in-app hint while one in another project does; "Unmute notifications" undoes it.
 * Own server (worker) for the file – the sidebar holds exactly the sessions of the test.
 */
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { chooseMenuItem, ParallaxApp, type SessionView } from './support/app';
import { expect, test } from './support/fixtures';
import { connectNodeClient, nodeCommand, serverSettings } from './support/server';

test.use({ ownServer: 'a1overview' });

const sentPresenceSchema = z.object({
  type: z.enum(['clientHello', 'presence']),
  presence: z.object({ viewingEntryId: z.string().nullable() }),
});

/**
 * The `viewingEntryId` of every presence the page sends (register before the page opens). The client
 * debounces presence changes (250 ms): a test that switches away and back faster than that would
 * never tell the server it left – it waits for the sent frame instead.
 */
function recordViewing(page: Page): (string | null)[] {
  const viewing: (string | null)[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const sent = sentPresenceSchema.safeParse(parsed);
      if (sent.success) viewing.push(sent.data.presence.viewingEntryId);
    });
  });
  return viewing;
}

test('sidebar filter by text and "Unread", mark as unread/read, mute a project from its header', async ({
  server,
  page,
}) => {
  const viewing = recordViewing(page);
  const app = await new ParallaxApp(page, server).open();
  const started: { cwd: string; session: SessionView }[] = [];
  for (const name of ['alpha', 'gamma', 'beta']) {
    const cwd = await server.makeProject(`ovw-${name}`);
    const session = await app.newSession(cwd);
    await session.send(`hello ${name}`);
    await expect(session.assistantText(`Echo: hello ${name}`)).toBeVisible();
    await expect(session.header.locator('h1')).toHaveText(`Fake: hello ${name}`);
    started.push({ cwd, session });
  }
  const [alpha, gamma, beta] = started.map((entry) => entry.session);
  const alphaCwd = started[0]?.cwd;
  if (alpha === undefined || gamma === undefined || beta === undefined || alphaCwd === undefined) {
    throw new Error('sessions missing');
  }
  expect(await app.selectedSessionKey()).toBe(beta.key);
  const all = new Set([alpha.key, beta.key, gamma.key]);
  const filterBar = page.locator('[data-slot="sidebar-filter"]');
  const filterText = filterBar.locator('[data-slot="sidebar-filter-text"]');

  // Text filter: the folder of one session; no match → hint and reset.
  await filterText.fill('ovw-gamma');
  await expect.poll(() => app.rowKeys()).toEqual([gamma.key]);
  await expect(filterBar).toHaveAttribute('data-active', 'true');
  await filterText.fill('matches-no-session');
  await expect(page.locator('[data-slot="sidebar-filter-empty"]')).toBeVisible();
  await page.locator('[data-action="reset-filter"]').click();
  await expect(filterText).toHaveValue('');
  await expect.poll(async () => new Set(await app.rowKeys())).toEqual(all);

  // Mark as unread: the shown session (header menu) and another one (row menu).
  await beta.headerAction('unread');
  await expect(app.row(beta.key)).toContainText('Unread');
  const alphaMenu = await app.rowMenu(alpha.key);
  await expect(alphaMenu.locator('[data-action="unread"]')).toHaveText('Mark as unread');
  await chooseMenuItem(alphaMenu.locator('[data-action="unread"]'));
  await expect(app.row(alpha.key)).toContainText('Unread');
  await expect(app.row(gamma.key)).not.toContainText('Unread');

  // Status filter "Unread": both (the shown one stays unread while this window shows it).
  const unreadFilter = filterBar.locator('[data-filter="unread"]');
  await expect(unreadFilter.locator('[data-slot="filter-count"]')).toHaveText('2');
  await unreadFilter.click();
  await expect.poll(async () => new Set(await app.rowKeys())).toEqual(new Set([alpha.key, beta.key]));
  // "Mark as read" takes alpha out of the filtered list.
  const readMenu = await app.rowMenu(alpha.key);
  await expect(readMenu.locator('[data-action="unread"]')).toHaveText('Mark as read');
  await chooseMenuItem(readMenu.locator('[data-action="unread"]'));
  await expect.poll(() => app.rowKeys()).toEqual([beta.key]);
  await filterBar.locator('[data-filter="all"]').click();
  await expect.poll(async () => new Set(await app.rowKeys())).toEqual(all);
  await expect(app.row(beta.key)).toContainText('Unread');
  // Opening it anew (switching away and back) reads it.
  await app.selectSession(gamma.key);
  await expect.poll(() => viewing.at(-1)).toBe(gamma.entryId);
  await expect(app.row(beta.key)).toContainText('Unread');
  await app.selectSession(beta.key);
  await expect.poll(() => viewing.at(-1)).toBe(beta.entryId);
  await expect(app.row(beta.key)).not.toContainText('Unread');

  // Grouped by project: mute alpha's project from its header.
  await page.locator('[data-slot="sidebar-mode"]').click();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'grouped');
  const alphaGroup = app
    .sidebar()
    .getByRole('group')
    .filter({ has: app.row(alpha.key) });
  const muteItem = page.locator('[role="menu"] [data-action="mute-project"]');
  await alphaGroup.locator('[data-group-toggle]').click({ button: 'right' });
  await expect(muteItem).toHaveText('Mute notifications');
  await chooseMenuItem(muteItem);
  await expect(alphaGroup.locator('[data-slot="group-muted"]')).toBeVisible();
  await expect
    .poll(async () => (await serverSettings(server)).notifications.mutedProjects)
    .toEqual([alphaCwd]);

  // A question in the muted project brings no hint; one in another project does (in that order).
  const client = await connectNodeClient(server);
  try {
    await nodeCommand(client, {
      name: 'session.sendPrompt',
      entryId: alpha.entryId,
      prompt: { text: 'fake:question in a muted project' },
      priority: 'next',
    });
    await expect(app.rowStatus(alpha.key)).toHaveAttribute('data-status', 'needs-answer');
    await nodeCommand(client, {
      name: 'session.sendPrompt',
      entryId: gamma.entryId,
      prompt: { text: 'fake:question in another project' },
      priority: 'next',
    });
  } finally {
    client.socket.terminate();
  }
  await expect(app.notices().filter({ hasText: 'Fake: hello gamma – has a question' })).toBeVisible();
  await expect(app.notices().filter({ hasText: 'Fake: hello alpha' })).toHaveCount(0);

  // Unmute.
  await alphaGroup.locator('[data-group-toggle]').click({ button: 'right' });
  await expect(muteItem).toHaveAttribute('data-muted', 'true');
  await expect(muteItem).toHaveText('Unmute notifications');
  await chooseMenuItem(muteItem);
  await expect(alphaGroup.locator('[data-slot="group-muted"]')).toHaveCount(0);
  await expect.poll(async () => (await serverSettings(server)).notifications.mutedProjects).toEqual([]);
});
