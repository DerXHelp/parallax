/**
 * WP-93 in Chrome against the built server (FakeBackend `fake:plan`): annotate the open plan in the
 * side panel tab "Plan" – a marked passage with "Comment" (key C), a marked passage with "Strike", a
 * whole passage with + at its edge; the passages are marked with the Custom Highlight API, the card
 * counts the annotations, they survive a reload (stored in the server), "Wide" (next to "Close")
 * widens the panel;
 * "Keep planning" in the tab sends them with the composer text, v2 follows and its changes to v1
 * list what was annotated there.
 * Own server; 1600 px wide (the side panel next to the transcript).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'p93annotate', viewport: { width: 1600, height: 900 } });

function highlightSize(page: Page, name: string): Promise<number> {
  return page.evaluate((key) => CSS.highlights.get(key)?.size ?? 0, name);
}

/** Selects the text of `target` like a user (triple click) and waits for the selection toolbar. */
async function selectPassage(panel: Locator, target: Locator): Promise<Locator> {
  await target.click({ clickCount: 3 });
  const toolbar = panel.locator('[data-slot="plan-selection-toolbar"]');
  await expect(toolbar).toBeVisible();
  return toolbar;
}

test('plan annotations: comment, strike, whole passage, reload, wide, keep planning, diff to v1', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('annotate'));
  await session.send('fake:plan make hello.txt');
  const card = await session.armedCard('plan');
  await expect(card).toContainText('Plan v1 ready');
  await card.locator('[data-action="open-plan"]').click();
  const panel = session.sidePanel.locator('[data-slot="plan-panel"]');
  // `## Plan`, two list items.
  const blocks = panel.locator('[data-plan-block]');
  await expect(blocks).toHaveCount(3);
  await expect(panel.locator('[data-slot="plan-annotation-bar"]')).toContainText('Select text to comment');

  // A marked passage → key C → comment.
  await selectPassage(panel, blocks.nth(1).locator('li'));
  await page.keyboard.press('c');
  const editor = panel.getByRole('textbox', { name: 'Comment' });
  await expect(editor).toBeFocused();
  await editor.fill('Use greeting.txt instead.');
  await editor.press('Enter');
  await expect(blocks.nth(1).locator('[data-slot="plan-annotation"]')).toContainText(
    'Use greeting.txt instead.',
  );
  await expect(blocks.nth(1).locator('[data-slot="plan-annotation"]')).toContainText('Create hello.txt');
  await expect.poll(() => highlightSize(page, 'plan-annotation')).toBe(1);

  // A marked passage → Strike.
  const toolbar = await selectPassage(panel, blocks.nth(2).locator('li'));
  await toolbar.getByRole('button', { name: 'Strike' }).click();
  await expect(blocks.nth(2).locator('[data-slot="plan-annotation"][data-kind="strike"]')).toBeVisible();
  await expect.poll(() => highlightSize(page, 'plan-strike')).toBe(1);

  // The whole heading with + at its edge.
  await blocks.nth(0).hover();
  await blocks.nth(0).getByRole('button', { name: 'Comment on this passage' }).click();
  await panel.getByRole('textbox', { name: 'Comment' }).fill('Name the goal.');
  await panel.getByRole('textbox', { name: 'Comment' }).press('Enter');
  await expect(panel.locator('[data-slot="plan-annotation-count"]')).toHaveText('3 annotations');
  await expect(card.locator('[data-slot="plan-annotation-badge"]')).toContainText('3');

  // Stored in the server: a reload brings them back.
  await page.reload();
  await app.waitConnected();
  await expect(session.pane).toBeVisible();
  const again = await session.armedCard('plan');
  await again.locator('[data-action="open-plan"]').click();
  await expect(panel.locator('[data-slot="plan-annotation"]')).toHaveCount(3);

  // "Wide": as wide as the panel may be (70 % of the session area).
  const before = (await session.sidePanel.boundingBox())?.width ?? 0;
  await session.sidePanel.locator('[data-action="side-panel-wide"]').click();
  await expect
    .poll(async () => (await session.sidePanel.boundingBox())?.width ?? 0)
    .toBeGreaterThan(before + 100);

  // "Keep planning" in the tab: annotations + composer text → v2.
  await session.composer.click();
  await session.composer.fill('Also add a README.');
  await panel.locator('[data-action="revise-annotations"]').click();
  await expect(session.card).toContainText('Plan v2 ready');
  await expect(session.composer).toHaveValue('');
  await panel.getByRole('radio', { name: 'Changes to v1' }).click();
  await expect(panel.locator('[data-slot="diff"] tr[data-kind="add"]')).toContainText(
    'Revision 1: Please revise the plan.',
  );
  const previous = panel.locator('[data-slot="plan-previous-annotations"]');
  await expect(previous).toContainText('Your 3 annotations on v1');
  await expect(previous).toContainText('Use greeting.txt instead.');
  await expect(previous).toContainText('Name the goal.');
  // The new version starts without annotations.
  await panel.getByRole('radio', { name: 'Plan' }).click();
  await expect(panel.locator('[data-slot="plan-annotation"]')).toHaveCount(0);
});
