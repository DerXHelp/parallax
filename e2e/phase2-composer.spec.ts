/**
 * Phase-2 composer and transcript (WP-37 over WP-31/WP-34; ADR-103/108/112):
 * - slash menu: fuzzy over the native and CLI commands, `/model haiku` changes the model,
 *   `/rename X` the title, `/clear` starts a new conversation in the same entry, a terminal command
 *   (`/vim`) shows the hint "Open in external console" instead of being sent;
 * - a pasted image (clipboard event with a PNG) becomes a chip, is uploaded and sent: the message
 *   shows the attachment, the fake answers "received 1 image(s)"; an image in a tool result
 *   (`fake:image`) opens in the lightbox, Esc closes it;
 * - rate limit (`fake:ratelimit`): banner → "Continue at HH:MM" plans the continue → "Cancel".
 */
import type { Locator } from '@playwright/test';
import { expect, test } from './support/fixtures';
import type { SessionView } from './support/app';

/** Types into the composer and presses Enter with the slash menu closed (Esc closes only the menu). */
async function run(session: SessionView, text: string): Promise<void> {
  await session.composer.click();
  await session.composer.fill(text);
  await session.composer.press('Escape');
  await session.composer.press('Enter');
}

test('slash menu: fuzzy, /model, /rename, /clear, terminal command hint', async ({ app, server, page }) => {
  const session = await app.newSession(await server.makeProject('slash'));
  await session.send('hello slash');
  await expect(session.assistantText('Echo: hello slash')).toBeVisible();

  // Fuzzy: "/mdl" finds /model (native commands first, with their argument hint).
  await session.composer.fill('/mdl');
  const menu = session.composerRoot.locator('[data-slot="slash-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option').first().locator('[data-command]')).toHaveAttribute(
    'data-command',
    'model',
  );
  // Tab takes the entry: "/model " plus the argument hint.
  await session.composer.press('Tab');
  await expect(session.composer).toHaveValue('/model ');
  await expect(menu).toHaveCount(0);

  // /model haiku → session.setModel (native, never sent to Claude).
  await session.composer.fill('/model haiku');
  await session.composer.press('Enter');
  await expect(session.composer).toHaveValue('');
  await expect(session.header.locator('[data-slot="header-model"]')).toContainText(/haiku/i);
  await expect(session.userMessages().filter({ hasText: '/model' })).toHaveCount(0);

  // /rename → the title (native).
  await run(session, '/rename Composer check');
  await expect(session.header.locator('h1')).toHaveText('Composer check');

  // /clear goes through to Claude: a new conversation in the same entry (same session key).
  await run(session, '/clear');
  await expect(session.assistantText('Echo: hello slash')).toHaveCount(0);
  await expect(session.userMessages()).toHaveCount(0);
  expect(await app.selectedSessionKey()).toBe(session.key);
  await expect(session.header.locator('h1')).toHaveText('Composer check');
  await session.send('after the clear');
  await expect(session.assistantText('Echo: after the clear')).toBeVisible();

  // A terminal-only command is not sent: hint with "Open in external console".
  await run(session, '/vim');
  const hint = session.composerRoot.locator('[data-slot="terminal-hint"]');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('/vim');
  await expect(hint.getByRole('button', { name: 'Open in external console' })).toBeVisible();
  await expect(session.composer).toHaveValue('/vim');
  await expect(session.userMessages().filter({ hasText: '/vim' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

/** Pastes a generated PNG into the composer (a clipboard event as Edge fires it for Ctrl+V). */
async function pasteImage(composer: Locator): Promise<void> {
  await composer.evaluate(async (field) => {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    ctx.fillStyle = '#e8590c';
    ctx.fillRect(0, 0, 48, 32);
    ctx.fillStyle = '#1c7ed6';
    ctx.fillRect(12, 8, 24, 16);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (blob === null) throw new Error('no PNG');
    const data = new DataTransfer();
    data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
}

test('a pasted image: chip → upload → sent; tool images open in the lightbox (Esc closes)', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('images'));
  await session.composer.click();
  await pasteImage(session.composer);
  const chip = session.composerRoot.locator('[data-slot="attachment-chip"]');
  await expect(chip).toHaveCount(1);
  // Prepared and uploaded (POST /api/attachments): "Ready".
  await expect(chip).toHaveAttribute('data-status', 'done');
  await expect(chip).toContainText('Ready');
  await session.composer.fill('what is on this screenshot?');
  await session.composer.press('Enter');
  await expect(chip).toHaveCount(0);
  const message = session.userMessages().filter({ hasText: 'what is on this screenshot?' });
  await expect(message.locator('[data-slot="image-thumb"]')).toHaveCount(1);
  await expect(session.assistantText('Fake: received 1 image(s)')).toBeVisible();

  // An image in a tool result (Read of a PNG) opens in the lightbox.
  await session.send('fake:image look at the screenshot');
  await expect(session.assistantText('The screenshot shows a window with an orange block.')).toBeVisible();
  // The tool call opens on a click and shows the image of its result.
  const read = session.toolCall('Read');
  await read.getByRole('button', { name: /Read/ }).first().click();
  const thumb = read.locator('[data-slot="image-thumb"]');
  await thumb.click();
  const lightbox = page.locator('[data-slot="lightbox"]');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('[data-slot="lightbox-save"]')).toHaveAttribute('href', /^\/api\/blob\//);
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  await expect(thumb).toBeFocused();
});

test('rate limit: banner → "Continue at HH:MM" plans the continue → Cancel', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('rate-limit'));
  await session.send('fake:ratelimit hit the limit');
  const banner = session.composerRoot.locator('[data-slot="rate-limit-banner"]');
  await expect(banner).toHaveAttribute('data-state', 'limited');
  await expect(banner).toContainText('Usage limit reached');
  await banner.getByRole('button', { name: /^Continue at / }).click();
  await expect(banner).toHaveAttribute('data-state', 'scheduled');
  await expect(banner).toContainText('Continue planned');
  await banner.getByRole('button', { name: 'Cancel' }).click();
  await expect(banner).toHaveAttribute('data-state', 'limited');
});
