/**
 * Phase-1 basics (Plan "Verifikation"): new session → first message → streamed answer, the queue
 * (`next` + header badge, ADR-041), Stop (button and Esc in the empty composer, R2W-07 e), the draft
 * surviving a reload (R2W-07 e).
 */
import { expect, test } from './support/fixtures';

/** `fake:slow`: 100 deltas of 200 ms (≈ 20 s at speed 1, docs/wp/WP-13a.md). */
const SLOW = 'fake:slow';

test('new session: first message starts claude and the answer streams in', async ({ app, server }) => {
  const cwd = await server.makeProject('first-message');
  const session = await app.newSession(cwd);
  await session.expectStatus('sleeping');

  await session.send('hello parallax');
  await expect(session.userMessages().filter({ hasText: 'hello parallax' })).toBeVisible();
  // The echo streams (assistant_text with data-streaming) and ends as a finished text.
  await expect(session.assistantText('Echo: hello parallax')).toBeVisible();
  await expect(session.assistantText('Echo: hello parallax')).not.toHaveAttribute('data-streaming', 'true');
  await expect(session.transcript.locator('[data-item-kind="turn_result"]')).toHaveCount(1);
  await session.expectStatus('idle');
  // The fake sets the AI title after the first turn.
  await expect(session.header.locator('h1')).toHaveText(/Fake: hello parallax/);
  await expect(session.composer).toHaveValue('');
  // The sidebar row shows the session.
  await expect(app.page.locator(`[data-session-row="${session.key}"]`)).toContainText('Fake: hello parallax');
});

test('queue: a message while Claude works waits (badge + grey row) and runs next', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('queue'));
  await session.send(SLOW);
  await expect(session.assistantText(/Line 2 of a slow answer/)).toBeVisible();
  await session.expectStatus('working');
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'queue');

  await session.send('after the slow one');
  const badge = session.header.locator('[data-slot="header-queued"]');
  await expect(badge).toHaveText('1 queued');
  const queued = session.transcript.locator('[data-row="queued"]');
  await expect(queued).toContainText('after the slow one');
  await expect(session.composer).toHaveValue('');

  // The slow turn ends by itself, then the queued prompt is taken over and answered.
  await expect(session.assistantText('Echo: after the slow one')).toBeVisible({ timeout: 60_000 });
  await expect(badge).toHaveCount(0);
  await expect(queued).toHaveCount(0);
  await expect(session.transcript.locator('[data-item-kind="turn_result"]')).toHaveCount(2);
  await session.expectStatus('idle');
});

test('stop: the Stop button interrupts a running turn', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('stop'));
  await session.send(SLOW);
  const answer = session.assistantText(/Line 3 of a slow answer/);
  await expect(answer).toBeVisible();
  await session.composerRoot.locator('[data-action="stop"]').click();
  await expect(session.composerRoot.locator('[data-action="stop"]')).toHaveCount(0);
  await expect(session.header).not.toHaveAttribute('data-status', 'working');
  await expect(session.transcript.locator('[data-item-kind="turn_result"]')).toContainText('Interrupted');
  // The text does not grow any more.
  const before =
    (await session.transcript.locator('[data-item-kind="assistant_text"]').last().textContent()) ?? '';
  await app.page.waitForTimeout(1000);
  const after =
    (await session.transcript.locator('[data-item-kind="assistant_text"]').last().textContent()) ?? '';
  expect(after).toBe(before);
  expect(after).not.toContain('Line 100');
});

test('Esc in the empty composer stops; a draft survives a reload (R2W-07 e)', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('esc-draft'));
  await session.send(SLOW);
  await expect(session.assistantText(/Line 2 of a slow answer/)).toBeVisible();
  await session.composer.focus();
  await session.composer.press('Escape');
  await expect(session.composerRoot.locator('[data-action="stop"]')).toHaveCount(0);
  await expect(session.transcript.locator('[data-item-kind="turn_result"]')).toContainText('Interrupted');

  // Esc with text in the composer never stops – and the draft is kept per session (localStorage).
  await session.composer.fill('a draft that must survive');
  await app.page.reload();
  await app.waitConnected();
  const again = app.session(session.key);
  await expect(again.composer).toHaveValue('a draft that must survive');
  // A restored draft has no Enter target: Enter sends it as a normal message.
  await again.composer.press('Enter');
  await expect(again.assistantText('Echo: a draft that must survive')).toBeVisible();
});
