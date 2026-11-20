/**
 * WP-94 (ADR-235): "New session" → folder browser against the real server (`fs.listDirectory`,
 * `fs.createDirectory` on a temp tree):
 * - a single click selects a subfolder, "Choose this folder" takes it without opening it;
 * - "New folder" creates the folder in the open one (on disk), selects it, and the session starts there.
 */
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './support/fixtures';

test('folder browser: a click selects a subfolder, "New folder" creates one and the session starts in it', async ({
  app,
  server,
  page,
}) => {
  const root = await server.makeProject('wp94');
  for (const folder of [
    ['bla', 'blub', 'foobar'],
    ['bla', 'other'],
  ]) {
    await mkdir(path.join(root, ...folder), { recursive: true });
  }
  const blub = path.join(root, 'bla', 'blub');
  // CSS strings treat "\" as an escape: a Windows path in an attribute selector needs it doubled.
  const css = (value: string) => value.replaceAll('\\', '\\\\');

  await page.locator('[data-action="new-session"]').click();
  const dialog = page.locator('[data-slot="new-session-dialog"]');
  const cwd = dialog.locator('input[name="cwd"]');
  await cwd.fill(blub);
  await dialog.locator('[data-action="browse-folder"]').click();
  const browser = page.locator('[data-slot="folder-browser"]');
  const list = browser.locator('[data-slot="folder-list"]');
  const footer = browser.locator('[data-slot="folder-browser-current"]');
  await expect(list).toHaveAttribute('data-path', blub);
  await expect(footer).toHaveAttribute('data-target', blub);

  // One click on "foobar": selected, not opened.
  const foobar = path.join(blub, 'foobar');
  await list.locator(`[role="option"][data-path="${css(foobar)}"]`).click();
  await expect(list.locator(`[role="option"][data-path="${css(foobar)}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(footer).toHaveAttribute('data-target', foobar);
  await expect(list).toHaveAttribute('data-path', blub);
  await browser.locator('[data-action="choose-folder"]').click();
  await expect(browser).toHaveCount(0);
  await expect(cwd).toHaveValue(foobar);

  // "New folder" in the open folder: created on disk, selected, chosen.
  await cwd.fill(blub);
  await dialog.locator('[data-action="browse-folder"]').click();
  await expect(list).toHaveAttribute('data-path', blub);
  await browser.locator('[data-action="folder-new"]').click();
  const name = browser.locator('input[name="folder-name"]');
  await expect(name).toBeFocused();
  await name.fill('Neues Projekt');
  await name.press('Enter');
  const created = path.join(blub, 'Neues Projekt');
  await expect(list.locator(`[role="option"][data-path="${css(created)}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(name).toHaveCount(0);
  expect((await stat(created)).isDirectory()).toBe(true);

  // The same name again: the server says it exists, nothing else happens.
  await browser.locator('[data-action="folder-new"]').click();
  await name.fill('neues projekt');
  await browser.locator('[data-action="folder-create"]').click();
  await expect(browser.locator('[data-folder-create-error="FOLDER_EXISTS"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(name).toHaveCount(0);
  await expect(browser).toBeVisible();

  await expect(footer).toHaveAttribute('data-target', created);
  await browser.locator('[data-action="choose-folder"]').click();
  await expect(browser).toHaveCount(0);
  await expect(cwd).toHaveValue(created);
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  const key = await app.waitForSelection((k) => k !== null);
  await expect(app.row(key).locator('[data-slot="row-path"]')).toHaveText('blub\\Neues Projekt');
});
