/**
 * WP-66 (side question `/btw`, withdraw a waiting message) against the FakeBackend:
 * - §1.2 a side question while a turn works (composer side mode): the card in the transcript, the turn
 *   goes on and ends normally; a follow-up in the same thread; after a reload the card is still there;
 *   Delete removes the thread (also after the next reload);
 * - §1.2 "Quick question…" from the sidebar on a sleeping session: the answer in the popover, a
 *   follow-up, "Open session" shows the card – no turn ran;
 * - §1.5 "Take back" on a waiting message: the text goes back into the field and never runs; a message
 *   the CLI already took over (`fake:taken`) gives the notice and stays in the queue.
 * The fake side answer names the question, the follow-up number and the turn state
 * (src/server/backend/fake/sideQuestion.ts).
 */
import type { SessionView } from './support/app';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp66' });

/** `fake:slow`: 100 deltas of 200 ms (≈ 20 s at speed 1). */
const SLOW = 'fake:slow';

function sideCard(session: SessionView) {
  return session.transcript.locator('[data-item-kind="side_question"]');
}

function answered(card: ReturnType<typeof sideCard>) {
  return card.locator('[data-side-entry][data-status="answered"]');
}

test('side question while Claude works: card, the turn goes on; follow-up; reload keeps it; delete', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('side'));
  await session.send(SLOW);
  await expect(session.assistantText(/Line 2 of a slow answer/)).toBeVisible();
  await session.expectStatus('working');

  // Side mode: the toggle next to Send, one question, also while Claude works.
  const toggle = session.composerRoot.locator('[data-action="side-question"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'side');
  await expect(session.composer).toBeFocused();
  await session.composer.fill('What are you doing right now?');
  await session.composer.press('Enter');
  await expect(session.composer).toHaveValue('');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'queue');

  const card = sideCard(session);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Side question · not in the context');
  await expect(answered(card)).toHaveText(
    /What are you doing right now\?.*Fake side answer: “What are you doing right now\?” – Claude is working on a turn\./,
  );
  // Not part of the conversation: no user message, nothing queued, the turn keeps running.
  await expect(session.userMessages().filter({ hasText: 'What are you doing right now?' })).toHaveCount(0);
  await expect(session.header.locator('[data-slot="header-queued"]')).toHaveCount(0);
  await session.expectStatus('working');

  // Follow-up in the same thread: still one card, now two answers.
  await card.locator('[data-action="side-follow-up"]').click();
  const field = card.getByRole('textbox', { name: 'Follow up' });
  await expect(field).toBeFocused();
  await field.fill('And after that?');
  await field.press('Enter');
  await expect(answered(card)).toHaveCount(2);
  await expect(answered(card).nth(1)).toContainText('Fake side answer (follow-up 1): “And after that?”');
  await expect(card).toHaveCount(1);

  // The slow turn ends by itself – the side questions did not touch it.
  await expect(session.transcript.locator('[data-item-kind="turn_result"]')).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(session.assistantText(/Line 100 of a slow answer/)).toBeVisible();
  await session.expectStatus('idle');

  // Reload: the card is still there (the items are in the log).
  await page.reload();
  await app.waitConnected();
  const again = app.session(session.key);
  await expect(again.pane).toBeVisible();
  await expect(answered(sideCard(again))).toHaveCount(2);
  await expect(sideCard(again)).toContainText('What are you doing right now?');

  // Delete removes the whole thread – also after the next reload.
  await sideCard(again).locator('[data-action="side-delete"]').click();
  await expect(sideCard(again)).toHaveCount(0);
  await page.reload();
  await app.waitConnected();
  await expect(app.session(session.key).transcript.locator('[data-item-kind="turn_result"]')).toHaveCount(1);
  await expect(sideCard(app.session(session.key))).toHaveCount(0);
});

test('"Quick question…" on a sleeping session: answer and follow-up in the popover, no turn; "Open session" shows the card', async ({
  app,
  server,
  page,
}) => {
  const first = await app.newSession(await server.makeProject('quick'));
  await first.send('hello quick');
  await expect(first.assistantText('Echo: hello quick')).toBeVisible();
  await first.expectStatus('idle');
  await first.headerAction('sleep');
  await first.expectStatus('sleeping');
  // Another session is shown meanwhile.
  const other = await app.newSession(await server.makeProject('quick-other'));
  await expect(other.pane).toBeVisible();

  await app.rowAction(first.key, 'quickAsk');
  const popover = page.locator('[data-slot="quick-ask"]');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Answered from the conversation – does not go into the context.');
  const field = popover.getByRole('textbox', { name: 'Ask about this session…' });
  await expect(field).toBeFocused();
  await field.fill('What did we do so far?');
  await field.press('Enter');
  await expect(popover.locator('[data-side-entry][data-status="answered"]')).toContainText(
    'Fake side answer: “What did we do so far?” – Claude is idle.',
  );

  const followUp = popover.getByRole('textbox', { name: 'Follow up…' });
  await followUp.fill('And next?');
  await followUp.press('Enter');
  await expect(popover.locator('[data-side-entry][data-status="answered"]')).toHaveCount(2);
  await expect(popover).toContainText('Fake side answer (follow-up 1): “And next?”');

  // "Open session": the popover closes, the session shows the thread as one card – and no new turn.
  await popover.locator('[data-action="quick-ask-open"]').click();
  await expect(popover).toHaveCount(0);
  await app.waitForSelection((key) => key === first.key);
  await expect(answered(sideCard(first))).toHaveCount(2);
  await expect(first.transcript.locator('[data-item-kind="turn_result"]')).toHaveCount(1);
  await expect(first.userMessages()).toHaveCount(1);
});

test('take back a waiting message: the text returns to the field and never runs; already taken over → notice', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('withdraw'));
  await session.send(SLOW);
  await expect(session.assistantText(/Line 2 of a slow answer/)).toBeVisible();
  await session.expectStatus('working');

  await session.send('Then run the linter');
  const queued = session.transcript.locator('[data-row="queued"]');
  const badge = session.header.locator('[data-slot="header-queued"]');
  await expect(queued).toContainText('Then run the linter');
  await expect(badge).toHaveText('1 queued');
  await expect(session.composer).toHaveValue('');

  await queued.locator('[data-action="withdraw"]').click();
  await expect(session.composer).toHaveValue('Then run the linter');
  await expect(session.composer).toBeFocused();
  await expect(queued).toHaveCount(0);
  await expect(badge).toHaveCount(0);

  // The CLI took this one over already: the notice, the message stays queued and runs next.
  await session.composer.fill('');
  await session.send('fake:taken now');
  await expect(queued).toContainText('fake:taken now');
  await queued.locator('[data-action="withdraw"]').click();
  await expect(
    app.notices().filter({ hasText: 'Already taken over – Claude has the message.' }),
  ).toBeVisible();
  await expect(queued).toHaveCount(1);
  await expect(session.composer).toHaveValue('');

  await expect(session.assistantText('Echo: fake:taken now')).toBeVisible({ timeout: 60_000 });
  await expect(session.transcript.locator('[data-item-kind="turn_result"]')).toHaveCount(2);
  await session.expectStatus('idle');
  await expect(session.userMessages().filter({ hasText: 'Then run the linter' })).toHaveCount(0);
});
