/**
 * Phase-3 verification "plan" (WP-60 E2E 5; WP-51/52/56/58): the side panel tab "Plan" shows the
 * plan file live while Claude writes it, then the file; feedback in the composer gives v2, shown as
 * the changes to v1; "With fresh context" starts a new conversation whose first prompt is the
 * engine's `Implement the following approved plan.` (the fake answers it); the split button keeps
 * the choice over a reload; after the approval the header offers "Plan".
 * Own server; 1600 px wide (the side panel next to the transcript).
 */
import { chooseMenuItem } from './support/app';
import { recordTexts, seenTexts } from './support/files';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'p3plan', viewport: { width: 1600, height: 900 } });

test('plan: live file, v1 → feedback → v2 with diff, fresh context, remembered choice, header "Plan"', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('plan'));
  // The tab "Plan" is open before Claude writes (no plan yet: no header button – the panel's tab).
  await session.openPanel('files');
  await session.panelTab('plan').click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'plan');
  const panel = session.sidePanel.locator('[data-slot="plan-panel"]');
  await expect(panel).toBeVisible();
  await recordTexts(page, `[data-side-panel="${session.key}"] [data-slot="plan-live"]`);

  await session.send('fake:plan make hello.txt');
  const v1 = await session.armedCard('plan');
  await expect(v1).toContainText('Plan v1 ready');
  // While the Write streamed: the plan text live in the panel; then the real plan file.
  expect((await seenTexts(page)).some((text) => text.includes('hello.txt'))).toBe(true);
  await expect(panel.locator('[data-slot="plan-live"]')).toHaveCount(0);
  await expect(panel.locator('[data-slot="plan-file"] [data-slot="file-link"]')).toContainText(
    'fake-plan.md',
  );
  await expect(panel.locator('[data-slot="plan-content"]')).toContainText('Create hello.txt');

  // Feedback → v2; the panel shows its changes to v1.
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'answer-plan');
  await session.composer.click();
  await session.composer.fill('Also add a README.');
  await session.composer.press('Enter');
  const v2 = session.card;
  await expect(v2).toContainText('Plan v2 ready');
  await expect(v2).toHaveAttribute('data-armed', 'true');
  await panel.getByRole('radio', { name: 'Changes to v1' }).click();
  await expect(panel).toHaveAttribute('data-plan-mode', 'changes');
  await expect(panel.locator('[data-slot="diff"] tr[data-kind="add"]')).toContainText(
    'Revision 1: Also add a README.',
  );

  // "With fresh context" + Manual: the toggle keeps the menu open, the mode closes it.
  await v2.getByRole('button', { name: 'How should Claude implement the plan?' }).click();
  await page.locator('[role="menu"] [data-toggle="fresh"]').click();
  await expect(page.locator('[role="menu"] [data-toggle="fresh"]')).toHaveAttribute('aria-checked', 'true');
  await chooseMenuItem(page.getByRole('menuitemradio', { name: /Manual – approve each change/ }));
  const approve = v2.locator('[data-action="approve"]');
  await expect(approve).toHaveText('Implement · Manual · fresh context');
  await expect(approve).toHaveAttribute('data-fresh', 'true');
  await approve.click();

  // A new conversation: the engine's implement prompt first, the fake answers it.
  await expect(session.card).toHaveCount(0);
  await expect(session.userMessages().first()).toContainText('Implement the following approved plan.');
  await expect(session.assistantText(/Fake: implementing plan \(\d+ lines\)/)).toBeVisible();
  await expect(session.assistantText('Plan v1 ready')).toHaveCount(0);
  await session.expectStatus('idle');

  // After the approval the header offers "Plan": the stored versions stay readable.
  await expect(session.panelButton('plan')).toBeVisible();
  await session.panelButton('files').click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'files');
  await session.openPanel('plan');
  await expect(panel.locator('[data-slot="plan-version-menu"]')).toBeVisible();
  await expect(panel.locator('[data-slot="plan-content"]')).toContainText('Revision 1: Also add a README.');

  // The split button remembers mode and "fresh context" over a reload.
  await page.reload();
  await app.waitConnected();
  await expect(session.pane).toBeVisible();
  await session.send('fake:plan once more');
  const again = await session.armedCard('plan');
  await expect(again.locator('[data-action="approve"]')).toHaveAttribute('data-mode', 'default');
  await expect(again.locator('[data-action="approve"]')).toHaveAttribute('data-fresh', 'true');
  await again.locator('[data-action="approve"]').click();
  await expect(session.card).toHaveCount(0);
  // Again a new conversation: the planning prompt is gone, the implement prompt is answered.
  await expect(session.userMessages().filter({ hasText: 'fake:plan once more' })).toHaveCount(0);
  await expect(session.assistantText(/Fake: implementing plan \(\d+ lines\)/)).toBeVisible();
  await session.expectStatus('idle');
});
