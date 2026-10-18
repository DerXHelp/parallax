/**
 * Phase-2 "New session" and profiles (WP-36 over WP-32/WP-33, ADR-102/119):
 * - the dialog pre-selects the default profile; the folder browser (`fs.listDirectory` on a temp
 *   tree with subfolders and a hidden folder) takes the chosen folder exactly; "New session in this
 *   project…" of a session pre-fills its folder;
 * - profiles: create one (colour, env with a masked `*_TOKEN` value), "Test profile", make it the
 *   default (the dialog pre-selects it), deleting is blocked while a session uses it.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ParallaxApp } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { startE2eServer, type E2eServer } from './support/server';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

test('dialog: default profile pre-selected, the folder browser takes the folder exactly, "New session in this project…"', async ({
  app,
  server,
  page,
}) => {
  const root = await server.makeProject('tree');
  for (const folder of ['app\\src', 'app\\test', 'docs', '.hidden']) {
    await mkdir(path.join(root, folder), { recursive: true });
  }

  await page.locator('[data-action="new-session"]').click();
  const dialog = page.locator('[data-slot="new-session-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-slot="profile-select"]')).toHaveAttribute('data-profile-id', 'standard');

  // Browse from the typed folder: folders only, hidden ones on request.
  await dialog.locator('input[name="cwd"]').fill(root);
  await dialog.locator('[data-action="browse-folder"]').click();
  const browser = page.locator('[data-slot="folder-browser"]');
  const list = browser.locator('[data-slot="folder-list"]');
  await expect(list).toHaveAttribute('data-path', root);
  const names = () => list.getByRole('option').allTextContents();
  await expect.poll(names).toEqual(['app', 'docs']);
  await browser.locator('[data-action="folder-show-hidden"]').click();
  await expect.poll(names).toEqual(['.hiddenHidden', 'app', 'docs']);
  await list.getByRole('option', { name: /^app/ }).dblclick();
  await expect(list).toHaveAttribute('data-path', path.join(root, 'app'));
  await list.getByRole('option', { name: /^src/ }).dblclick();
  const chosen = path.join(root, 'app', 'src');
  await expect(list).toHaveAttribute('data-path', chosen);
  await browser.locator('[data-action="choose-folder"]').click();
  await expect(browser).toHaveCount(0);
  await expect(dialog.locator('input[name="cwd"]')).toHaveValue(chosen);

  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  const key = await app.waitForSelection((k) => k !== null);
  await expect(app.row(key).locator('[data-slot="row-path"]')).toHaveText('app\\src');

  // "New session in this project…" (context menu of the row) pre-fills the folder.
  await (await app.rowMenu(key)).locator('[data-action="newSessionHere"]').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name="cwd"]')).toHaveValue(chosen);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('profiles: create (colour, masked *_TOKEN), test, make default, delete blocked while in use', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'profiles' });
  const app = await new ParallaxApp(page, own).open();

  const settings = await app.openSettingsPage('profiles');
  const section = settings.locator('[data-slot="profiles-settings"]');
  await expect(section.locator('[data-profile-row="standard"]')).toBeVisible();
  await section.locator('[data-action="profile-new"]').click();
  const editor = section.locator('[data-slot="profile-editor"]');
  await expect(editor).toHaveAttribute('data-profile-id', 'new');
  await editor.getByLabel('Name', { exact: true }).fill('Work');
  await editor.locator('[data-slot="profile-color"] [data-color="green"]').click();
  await editor.locator('[data-action="env-add"]').click();
  const envRow = editor.locator('[data-env-row]').first();
  await envRow.locator('input[data-part="key"]').fill('GATEWAY_TOKEN');
  const value = envRow.locator('input[data-part="value"]');
  await value.fill('tok-e2e-secret');
  // A secret name masks its value (ADR-102, WP-36 §2.2).
  await expect(value).toHaveAttribute('type', 'password');
  await expect(value).toHaveAttribute('data-masked', 'true');
  await editor.locator('[data-action="profile-save"]').click();

  // Saved: a pf_ id, the list shows it, the value stays masked in the reloaded editor.
  await expect(editor).toHaveAttribute('data-profile-id', /^pf_/);
  const profileId = (await editor.getAttribute('data-profile-id')) ?? '';
  await expect(section.locator(`[data-profile-row="${profileId}"]`)).toContainText('Work');
  await expect(editor.locator('[data-env-row] input[data-part="value"]')).toHaveAttribute('type', 'password');

  // "Test profile" (fake integration: ok, logged in).
  await editor.locator('[data-action="profile-test"]').click();
  await expect(editor.locator('[data-slot="profile-test-result"]')).toContainText('2.1.300');

  // Default: the dialog pre-selects it from now on.
  await editor.locator('[data-action="profile-default"]').click();
  await expect(editor.locator('[data-action="profile-default"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.locator('[data-action="new-session"]').click();
  const dialog = page.locator('[data-slot="new-session-dialog"]');
  await expect(dialog.locator('[data-slot="profile-select"]')).toHaveAttribute('data-profile-id', profileId);
  await dialog.locator('input[name="cwd"]').fill(await own.makeProject('work'));
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  const session = app.session(await app.waitForSelection((key) => key !== null));
  await session.send('hello work');
  await expect(session.assistantText('Echo: hello work')).toBeVisible();

  // Deleting is blocked while a session uses the profile (entryCount, archived ones included).
  const again = await app.openSettingsPage('profiles');
  await again.locator(`[data-profile-row="${profileId}"]`).click();
  const reopened = again.locator(`[data-slot="profile-editor"][data-profile-id="${profileId}"]`);
  await expect(reopened.locator('[data-action="profile-delete"]')).toBeDisabled();
  await expect(reopened.locator('[data-slot="profile-delete-reason"]')).toBeVisible();
  // The built-in profile can never be deleted.
  await again.locator('[data-profile-row="standard"]').click();
  await expect(
    again.locator('[data-slot="profile-editor"][data-profile-id="standard"] [data-action="profile-delete"]'),
  ).toBeDisabled();
});
