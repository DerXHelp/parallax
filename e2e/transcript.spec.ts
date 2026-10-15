/**
 * Behaviour that only the real layout shows (R2W-07 a–c; happy-dom has no layout):
 * (a) streaming sticks to the end, scrolling up unsticks, "Jump to latest" sticks again;
 * (b) `loadEarlier` while scrolling up keeps the reading position (virtua `shift`);
 * (c) Enter/Space/typing on a focused answer button never answers; Mod+Enter only with the focus
 *     in the card.
 */
import type { Locator } from '@playwright/test';
import { connectNodeClient, nodeCommand, type E2eServer } from './support/server';
import { expect, test } from './support/fixtures';

/** Distance from the end that still counts as "at the bottom" (TranscriptView STICK_PX). */
const STICK_PX = 48;

// A shorter window: the transcript overflows sooner.
test.use({ viewport: { width: 1200, height: 600 } });

function distanceFromEnd(list: Locator): Promise<number> {
  return list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
}

/** Sends echo prompts over the protocol (faster than typing); they queue and run in order. */
async function sendEchoes(server: E2eServer, entryId: string, count: number): Promise<void> {
  const client = await connectNodeClient(server);
  try {
    for (let n = 1; n <= count; n++) {
      await nodeCommand(client, {
        name: 'session.sendPrompt',
        entryId,
        prompt: { text: `message ${String(n).padStart(2, '0')}` },
        priority: 'next',
      });
    }
  } finally {
    client.socket.terminate();
  }
}

test('(a) streaming sticks to the end; scrolling up unsticks; "Jump to latest" sticks again', async ({
  app,
  server,
}) => {
  test.setTimeout(180_000);
  const session = await app.newSession(await server.makeProject('stick'));
  // Some history first (the transcript overflows), then a long stream (≈ 20 s).
  await sendEchoes(server, session.entryId, 8);
  await expect(session.assistantText('Echo: message 08')).toBeVisible({ timeout: 60_000 });
  const list = session.list();
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 300)).toBe(true);
  await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(STICK_PX);
  await session.send('fake:slow');
  await expect(session.assistantText(/Line 10 of a slow answer/)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(STICK_PX);

  // Scroll up: the list stays where the user is while the text keeps growing.
  await list.hover();
  await app.page.mouse.wheel(0, -500);
  const jump = session.transcript.getByRole('button', { name: 'Jump to latest' });
  await expect(jump).toBeVisible();
  const top = await list.evaluate((el) => el.scrollTop);
  await app.page.waitForTimeout(1200);
  expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - top)).toBeLessThanOrEqual(2);
  expect(await distanceFromEnd(list)).toBeGreaterThan(STICK_PX);

  // "Jump to latest" → at the end again, and it follows the stream from there.
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(STICK_PX);
  await app.page.waitForTimeout(1200);
  expect(await distanceFromEnd(list)).toBeLessThanOrEqual(STICK_PX);
  await session.composerRoot.locator('[data-action="stop"]').click();
});

test('(b) loading earlier items while scrolling up keeps the reading position', async ({ app, server }) => {
  test.setTimeout(240_000);
  const session = await app.newSession(await server.makeProject('earlier'));
  // > LIMITS.snapshotItems (150) top-level items: 40 echo turns of 4 items each.
  const TURNS = 40;
  await sendEchoes(server, session.entryId, TURNS);
  await expect(session.assistantText(`Echo: message ${String(TURNS)}`)).toBeAttached({ timeout: 180_000 });
  await session.expectStatus('idle');

  // A reload subscribes again: the snapshot carries the last 150 items and `hasEarlier`.
  await app.page.reload();
  await app.waitConnected();
  const view = app.session(session.key);
  const list = view.list();
  await expect(view.assistantText(`Echo: message ${String(TURNS)}`)).toBeVisible();
  await expect.poll(() => distanceFromEnd(list)).toBeLessThanOrEqual(STICK_PX);
  await expect(view.userMessages().filter({ hasText: 'message 01' })).toHaveCount(0);

  // Close to the top, but above the loadEarlier threshold (240 px): pick an anchor message.
  await list.evaluate((el) => {
    el.scrollTop = 700;
  });
  await app.page.waitForTimeout(300);
  const anchor = view.userMessages().first();
  const anchorText = (await anchor.textContent()) ?? '';
  const anchored = view.userMessages().filter({ hasText: anchorText });
  const before = (await anchored.boundingBox())?.y ?? Number.NaN;
  // Scroll 500 px further up → loadEarlier prepends the older items.
  await list.evaluate((el) => {
    el.scrollTop = 200;
  });
  await expect(view.transcript.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await app.page.waitForTimeout(500);
  // Without virtua's `shift` the anchor would jump down by the height of everything prepended.
  const after = (await anchored.boundingBox())?.y ?? Number.NaN;
  expect(Math.abs(after - (before + 500))).toBeLessThanOrEqual(80);
  // The oldest messages are there now.
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(view.userMessages().filter({ hasText: 'message 01' })).toBeVisible();
});

test('(c) Enter, Space and typing on a focused answer button never answer; Mod+Enter only in the card', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('keys'));
  await session.send('fake:permission keys');
  const card = await session.armedCard('permission');
  const allow = card.locator('[data-action="allow-once"]');

  await allow.focus();
  await expect(allow).toBeFocused();
  await app.page.keyboard.press('Enter');
  await app.page.keyboard.press(' ');
  await app.page.keyboard.type('yes y');
  await app.page.waitForTimeout(800);
  await expect(card).toHaveAttribute('data-decision-state', 'open');
  await expect(session.card).toHaveCount(1);

  // Mod+Enter in the composer (outside the card) does not answer either.
  await session.composer.focus();
  await app.page.keyboard.press('Control+Enter');
  await app.page.waitForTimeout(800);
  await expect(session.card).toHaveCount(1);
  await expect(session.userMessages()).toHaveCount(1);

  // Mod+Enter with the focus on the answer button answers with that button.
  await allow.focus();
  await app.page.keyboard.press('Control+Enter');
  await expect(session.card).toHaveCount(0);
  await expect(session.toolCall('Bash')).toContainText('Allowed');
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
});
