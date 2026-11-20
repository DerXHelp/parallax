/**
 * WP-90/91 (GitHub #4, #2) in Chrome against the built server:
 * - Shift+Tab in the message field steps through the permission modes (target at once, one
 *   command after the pause; the FakeBackend reports the new mode);
 * - the sidebar: drag its edge, double click resets, dragged far left it collapses; Alt+B expands
 *   and collapses it; the rail has "New session", settings and a button per session.
 * Own server.
 */
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'uikomfort' });

/** WP-96: screen px per layout px at the setting 100 % (lib/zoom.ts BASE_ZOOM). */
const BASE = 1.1;
/** The default sidebar (288 layout px) as drawn. */
const DEFAULT_DRAWN = Math.round(288 * BASE);

test('Shift+Tab in the message field switches the permission mode', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('modes'));
  await session.send('hello modes');
  await expect(session.assistantText('Echo: hello modes')).toBeVisible();
  const picker = session.composerRoot.locator('[data-slot="mode-picker"]');
  await expect(picker).toHaveAttribute('data-mode', 'default');

  await session.composer.click();
  await session.composer.press('Shift+Tab');
  await expect(picker).toHaveAttribute('data-target-mode', 'acceptEdits');
  await session.composer.press('Shift+Tab');
  // Manual → Accept edits → Plan: one command with the last target, the label follows the server.
  await expect(picker).toHaveAttribute('data-mode', 'plan');
  await expect(picker).not.toHaveAttribute('data-target-mode', /./u);
  await expect(session.composer).toBeFocused();
});

test('sidebar: drag the edge, reset, collapse by dragging and with Alt+B; the rail buttons', async ({
  app,
  server,
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const session = await app.newSession(await server.makeProject('sidebar'));
  const frame = page.locator('[data-slot="sidebar-frame"]');
  const aside = frame.locator('aside');
  const handle = page.locator('[data-slot="sidebar-splitter"]');
  const width = async () => (await aside.boundingBox())?.width ?? 0;
  await expect(frame).toHaveAttribute('data-state', 'expanded');
  // 288 layout px, drawn at the base size (WP-96).
  expect(Math.round(await width())).toBe(DEFAULT_DRAWN);

  const drag = async (dx: number) => {
    const box = await handle.boundingBox();
    if (box === null) throw new Error('no handle');
    const x = box.x + box.width / 2;
    const y = box.y + 300;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 6 });
    await page.mouse.up();
  };

  await drag(100);
  await expect.poll(width).toBeGreaterThan(288 * BASE + 92);
  expect(await width()).toBeLessThan(288 * BASE + 108);
  // The handle reports layout px: the drawn width divided by the base size.
  await expect(handle).toHaveAttribute('aria-valuenow', String(Math.round((await width()) / BASE)));

  await handle.dblclick();
  await expect.poll(async () => Math.round(await width())).toBe(DEFAULT_DRAWN);

  // Far to the left: collapses into the rail, the width stays for the next expand.
  await drag(-250);
  await expect(frame).toHaveAttribute('data-state', 'collapsed');
  const rail = page.locator('[data-slot="sidebar-rail"]');
  await expect(rail).toBeVisible();
  await expect(rail.locator('[data-action="rail-new-session"]')).toBeVisible();
  await expect(rail.locator('[data-action="rail-settings"]')).toBeVisible();
  await expect(rail.locator(`[data-rail-session="${session.key}"]`)).toBeVisible();

  await session.composer.click();
  await page.keyboard.press('Alt+B');
  await expect(frame).toHaveAttribute('data-state', 'expanded');
  expect(Math.round(await width())).toBe(DEFAULT_DRAWN);
  await expect(session.composer).toBeFocused();
  await page.keyboard.press('Alt+B');
  await expect(frame).toHaveAttribute('data-state', 'collapsed');
  await expect(session.composer).toBeFocused();
});
