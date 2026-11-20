/**
 * WP-95 verification (FakeBackend, `fake:cli-notices`): the internal CLI messages appear as notices
 * instead of "Unknown event …":
 * - the Bash call shows "Checking permission…" while the automatic permission check holds it
 *   (`permission_check_status` checking → done, 3 s at speed 1), afterwards no longer;
 * - model fallback, missing attachments (1 of 2) and a held peer message that was not delivered;
 * - no row "Unknown event" at all;
 * - `/rename X` while the process runs: one quiet line "Title passed to Claude Code: X" instead of a
 *   user bubble, the CLI's answer "Session renamed to: …" is hidden.
 */
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp95' });

test('fake:cli-notices: permission check on the tool line, fallback, missing files, held message', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('cli-notices'));
  await session.send('fake:cli-notices');

  const bash = session.toolCall('Bash');
  const hint = bash.locator('[data-slot="permission-check"]');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('Checking permission…');

  await expect(session.assistantText('Committed. Opus was busy')).toBeVisible({ timeout: 15_000 });
  await session.expectStatus('idle');
  await expect(hint).toHaveCount(0);

  await expect(session.transcript).toContainText('Switched model: claude-opus-5-5 → claude-sonnet-5-5');
  await expect(session.transcript.locator('[data-slot="attachments-missing"]')).toContainText(
    '1 of 2 attached files did not arrive',
  );
  const peer = session.transcript.locator('[data-slot="peer-hold"]');
  await expect(peer).toHaveCount(1);
  await expect(peer).toHaveAttribute('data-state', 'dropped');
  await expect(peer).toContainText('Message from Fake peer not delivered');
  await expect(peer).toContainText('expired');
  await expect(session.transcript).not.toContainText('Unknown event');
});

test('/rename while running: a quiet title line, no user bubble, no "Session renamed to"', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('rename-echo'));
  await session.send('hello rename');
  await expect(session.assistantText('Echo: hello rename')).toBeVisible();
  await session.expectStatus('idle');

  await session.send('/rename Quiet title');
  await expect(session.header.locator('h1')).toHaveText('Quiet title');
  const line = session.transcript.locator('[data-slot="rename"]');
  await expect(line).toHaveText('Title passed to Claude Code: Quiet title');
  await session.expectStatus('idle');
  await expect(session.userMessages().filter({ hasText: '/rename' })).toHaveCount(0);
  await expect(session.transcript).not.toContainText('Session renamed to');
  await expect(session.assistantText('Echo: hello rename')).toBeVisible();
});
