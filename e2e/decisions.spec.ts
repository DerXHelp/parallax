/**
 * Non-modal decisions against the FakeBackend (Plan "Verifikation" Phase 1, "Plan-Modus &
 * Plan-Freigabe", ADR-012, ADR-040): permission once / always (destination session) / denied with
 * a reason, the effect in the fake (tool result + answer), AskUserQuestion, plan revise via the
 * composer → v2 → implement with the chosen mode.
 *
 * The FakeBackend does not touch the disk: the "file effect" is the tool result the fake returns
 * after the answer (`fake-dir`, "File created successfully …"); a real file follows in WP-22.
 */
import { expect, test } from './support/fixtures';

test('permission: allow once runs the tool', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('allow-once'));
  await session.send('fake:permission create a folder');
  const card = await session.armedCard('permission');
  await expect(card).toContainText('Bash needs your permission');
  await expect(card.locator('[data-slot="tool-input-summary"]')).toContainText('mkdir -p fake-dir');
  await session.expectStatus('needs-permission');
  // The transcript points at the bar (Variante A: no answer buttons there).
  await expect(session.transcript.locator('[data-slot="decision-line"]')).toBeVisible();

  await card.locator('[data-action="allow-once"]').click();
  await expect(session.card).toHaveCount(0);
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  const bash = session.toolCall('Bash');
  await expect(bash).toHaveAttribute('data-status', 'done');
  await expect(bash).toContainText('Allowed');
  await bash.getByRole('button').first().click();
  await expect(bash).toContainText('fake-dir');
  await session.expectStatus('idle');
});

test('permission: always allow for this session remembers the rule', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('allow-always'));
  await session.send('fake:bash again');
  const card = await session.armedCard('permission');
  const always = card.locator('[data-action="allow-always"]');
  // Default destination is the session (ADR-012) – no warning badge.
  await expect(always).toHaveText('Always allow · This session');
  await expect(card.locator('[data-slot="destination-warning"]')).toHaveCount(0);
  await always.click();
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  await expect(session.toolCall('Bash')).toContainText('Allowed and remembered for this session');
});

test('permission: deny with a reason sends the reason to Claude', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('deny-reason'));
  await session.send('fake:permission please');
  const card = await session.armedCard('permission');
  await card.getByRole('button', { name: 'More ways to deny' }).click();
  await app.page.getByRole('menuitem', { name: 'Deny with a reason…' }).click();
  const form = card.locator('[data-slot="deny-form"]');
  await expect(form.locator('textarea')).toBeFocused();
  await form.locator('textarea').fill('Use the existing folder instead.');
  await form.locator('[data-action="deny-reason"]').click();

  await expect(session.card).toHaveCount(0);
  await expect(session.assistantText('Okay, I did not run the command.')).toBeVisible();
  const bash = session.toolCall('Bash');
  await expect(bash).toContainText('Denied with a message to Claude');
  await bash.getByRole('button').first().click();
  await expect(bash).toContainText('Use the existing folder instead.');
});

test('permission for a file change shows the change and writes the file in the fake', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('edit'));
  await session.send('fake:edit write notes');
  const card = await session.armedCard('permission');
  await expect(card).toContainText('Write needs your permission');
  // Edit/Write: the preview of the change is open by default.
  await expect(card.locator('[data-slot="tool-input-preview"]').first()).toContainText('alpha');
  await card.locator('[data-action="allow-once"]').click();
  await expect(session.assistantText('The file fake-notes.txt was written.')).toBeVisible();
});

test('AskUserQuestion: pick an option and answer', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('question'));
  await session.send('fake:question colors');
  const card = await session.armedCard('question');
  await session.expectStatus('needs-answer');
  await expect(card).toContainText('Which color should the button be?');
  const answer = card.locator('[data-action="answer"]');
  await expect(answer).toBeDisabled();
  await card.getByRole('radio', { name: /Blue/ }).click();
  // The Markdown preview of the chosen option.
  await expect(card.locator('[data-slot="option-preview"]')).toContainText('<- blue');
  await answer.click();
  await expect(session.assistantText('You chose: Blue')).toBeVisible();
  await expect(session.toolCall('AskUserQuestion')).toContainText('Answered');
});

test('plan: feedback in the composer revises, v2 is implemented with the chosen mode', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('plan'));
  await session.send('fake:plan make hello.txt');
  const v1 = await session.armedCard('plan');
  await expect(v1).toContainText('Plan v1 ready');
  await session.expectStatus('needs-review');

  // Empty composer + main-agent plan shown ≥ arm delay: the first key fixes it as Enter target.
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'answer-plan');
  await session.composer.click();
  await session.composer.fill('Also add a README.');
  await session.composer.press('Enter');
  const v2 = session.card;
  await expect(v2).toContainText('Plan v2 ready');
  await expect(v2).toHaveAttribute('data-armed', 'true');
  await expect(session.composer).toHaveValue('');

  // Choose "Manual" in the ▾ menu, then implement (pointer click).
  await v2.getByRole('button', { name: 'How should Claude implement the plan?' }).click();
  await app.page.getByRole('menuitemradio', { name: /Manual – approve each change/ }).click();
  const approve = v2.locator('[data-action="approve"]');
  await expect(approve).toHaveText('Implement · Manual');
  await expect(approve).toHaveAttribute('data-mode', 'default');
  // Regression (WP-20c): the keyboard hint of the card vanished on this pointerdown and moved the
  // buttons – the pointerup landed elsewhere and the click was lost.
  await approve.click();

  await expect(session.card).toHaveCount(0);
  await expect(session.assistantText('IMPLEMENTED')).toBeVisible();
  await expect(session.header.locator('[data-slot="header-mode"]')).toHaveText('Manual');
  // The plan cards in the transcript keep their end states.
  await expect(session.transcript.locator('[data-plan-state="plan_revised"]')).toHaveCount(1);
  await expect(session.transcript.locator('[data-plan-state="plan_approved"]')).toHaveCount(1);
});
