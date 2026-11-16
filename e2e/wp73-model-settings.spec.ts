/**
 * WP-73 against the FakeBackend – Claude's own model settings:
 * - `fake:claude-model opusplan` + `fake:model-picker` (like an edited settings.json while the
 *   session runs) → the next opening of the model picker shows them: the trigger names "Opus Plan",
 *   the Default row "Follows your Claude settings: Opus Plan", the modelPicker rows as "Your models"
 *   between the aliases and "More models";
 * - Opus pinned, then Default again → the next turn runs on what opusplan resolves to
 *   (claude-sonnet-5-5), not on the CLI's built-in default (the fake's claude-haiku-5-5, ADR-199).
 * Own server (the fake Claude settings are shared by every session of a backend).
 */
import type { Locator } from '@playwright/test';
import { chooseMenuItem } from './support/app';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp73' });

/** The rows of the open model list: labels of the models, `#yours`/`#more` for the group headings. */
async function modelRows(menu: Locator): Promise<string[]> {
  const rows = await menu.locator('[data-slot="model-list"] > *').evaluateAll((elements) =>
    elements.map((element) => {
      const slot = element.getAttribute('data-slot');
      if (slot === 'model-yours') return '#yours';
      if (slot === 'model-more') return '#more';
      return element.querySelector('.grid')?.firstElementChild?.textContent ?? '';
    }),
  );
  return rows.filter((row) => row !== '');
}

test('Claude settings: "Default" follows opusplan, the modelPicker rows form "Your models"', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('models'));
  await session.send('fake:claude-model opusplan');
  await session.expectStatus('idle');
  await session.send('fake:model-picker');
  await session.expectStatus('idle');

  // Opening reloads the list together with Claude's settings.
  const picker = session.composerRoot.locator('[data-slot="model-picker"]');
  await picker.click();
  const menu = page.getByRole('menu');
  await expect(menu).toContainText('Follows your Claude settings: Opus Plan');
  await expect(picker).toHaveAccessibleName(/^Model: Opus Plan/);
  await expect(menu.getByRole('menuitemradio', { name: /Follows your Claude settings/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const rows = await modelRows(menu);
  const yours = rows.indexOf('#yours');
  expect(yours).toBeGreaterThan(0);
  // claude-opus-4-8 is a built-in row (its label stays), sonnet[1m] comes from the setting.
  expect(rows.slice(yours, yours + 4)).toEqual(['#yours', 'Opus 4.8', 'Sonnet 1M', '#more']);
  expect(rows.slice(0, yours)).toContain('Opus Plan');

  // Pin Opus: the next turn runs on it.
  await chooseMenuItem(menu.getByRole('menuitemradio', { name: /^Opus 5\.5/ }));
  await expect(picker).toHaveAccessibleName('Model: Opus 5.5');
  await session.send('Reply with exactly: OK');
  await session.expectStatus('idle');
  await expect(session.header.locator('[data-slot="header-model"]')).toContainText('claude-opus-5-5');

  // Back to Default: the CLI gets 'opusplan' (its "Opus Plan" row stays offered meanwhile).
  await picker.click();
  await expect(menu.getByRole('menuitemradio', { name: /^Opus Plan/ })).toBeVisible();
  await chooseMenuItem(menu.getByRole('menuitemradio', { name: /Follows your Claude settings/ }));
  await session.send('Reply with exactly: OK');
  await session.expectStatus('idle');
  await expect(session.header.locator('[data-slot="header-model"]')).toContainText('claude-sonnet-5-5');
  await expect(picker).toHaveAccessibleName('Model: Opus Plan · claude-sonnet-5-5');
});
