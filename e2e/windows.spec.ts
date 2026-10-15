/**
 * Several windows and the reload (architecture §5 (e), R2W-07 d, ADR-040, Plan "Verifikation":
 * "Nach einem Browser-Reload ist der Zustand inklusive offener Karte wieder da"):
 * - a decision answered in one window disappears in the other (`decision.resolved`) with a hint;
 *   two clicks at once → the first wins, both windows agree;
 * - target lock: a decision that appears while the user types is not answered by Enter;
 * - reload with an open card → the card is back and can be answered.
 */
import { expect, test } from './support/fixtures';

test('two windows: an answer in one resolves the card in the other; the first click wins', async ({
  app,
  server,
  newWindow,
}) => {
  const session = await app.newSession(await server.makeProject('two-windows'));
  // A second window (own window, signed in with its own code) on the same session.
  const other = await newWindow({ context: 'new', hash: `session=${session.key}` });
  const there = other.session(session.key);
  await expect(there.pane).toBeVisible();

  await session.send('fake:permission first');
  const here = await session.armedCard('permission');
  const card = await there.armedCard('permission');
  await expect(card).toHaveAttribute('data-decision-id', (await here.getAttribute('data-decision-id')) ?? '');

  await card.locator('[data-action="allow-once"]').click();
  // decision.resolved reaches the first window: card gone, hint "granted in another window".
  await expect(session.card).toHaveCount(0);
  await expect(
    app.notices().filter({ hasText: 'A permission was granted in another window.' }),
  ).toBeVisible();
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  await expect(there.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  // The answering window got no "elsewhere" hint.
  await expect(other.notices().filter({ hasText: 'in another window' })).toHaveCount(0);

  // Both click at the same time: exactly one answer counts, both windows show the same outcome.
  await session.send('fake:permission second');
  const a = await session.armedCard('permission');
  const b = await there.armedCard('permission');
  await Promise.allSettled([
    a.locator('[data-action="allow-once"]').click({ timeout: 5000 }),
    b.locator('[data-action="deny"]').click({ timeout: 5000 }),
  ]);
  await expect(session.card).toHaveCount(0);
  await expect(there.card).toHaveCount(0);
  const outcome = async (view: typeof session) => {
    const text = (await view.toolCall('Bash').nth(1).textContent()) ?? '';
    return /Allowed|Denied/.exec(text)?.[0] ?? '';
  };
  await expect.poll(() => outcome(session)).toMatch(/^(Allowed|Denied)$/);
  await expect.poll(() => outcome(there)).toBe(await outcome(session));
  await expect(session.assistantText(/Done: the folder|Okay, I did not run/).nth(1)).toBeVisible();
});

test('target lock: a decision that appears while typing is not answered by Enter (ADR-040)', async ({
  app,
  server,
  newWindow,
}) => {
  const session = await app.newSession(await server.makeProject('target-lock'));
  // Another window (own profile: own drafts) starts the turn while this window has a draft.
  const other = await newWindow({ context: 'new', hash: `session=${session.key}` });
  const there = other.session(session.key);
  await expect(there.pane).toBeVisible();

  await session.composer.click();
  await session.composer.fill('my next instruction');
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'idle');
  await there.send('fake:permission from the other window');

  const card = await session.armedCard('permission');
  // The decision is open, but not the Enter target of this draft: hint + explicit button.
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'pending-permission');
  await expect(session.composerRoot.locator('[data-slot="composer-pending"]')).toBeVisible();
  await expect(session.composerRoot.locator('[data-action="answer"]')).toBeEnabled();
  await session.composer.press('Enter');
  // Enter sent the text as a message (queued behind the decision) – the card is still open.
  await expect(session.header.locator('[data-slot="header-queued"]')).toHaveText('1 queued');
  await expect(session.transcript.locator('[data-row="queued"]')).toContainText('my next instruction');
  await expect(card).toHaveAttribute('data-decision-state', 'open');
  await expect(session.composer).toHaveValue('');

  // Counter-check: the decision was shown before this draft began → Enter answers it (deny + text).
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'answer-permission');
  await session.composer.fill('Do not create folders.');
  await session.composer.press('Enter');
  await expect(session.card).toHaveCount(0);
  await expect(session.toolCall('Bash')).toContainText('Denied with a message to Claude');
  await expect(session.assistantText('Okay, I did not run the command.')).toBeVisible();
  // … and the queued message runs afterwards.
  await expect(session.assistantText('Echo: my next instruction')).toBeVisible({ timeout: 30_000 });
});

test('reload with an open card: the card is back and can be answered', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('reload-card'));
  await session.send('fake:question pick one');
  const card = await session.armedCard('question');
  const id = await card.getAttribute('data-decision-id');

  await app.page.reload();
  await app.waitConnected();
  const again = app.session(session.key);
  await expect(again.card).toHaveAttribute('data-decision-id', id ?? '');
  await expect(again.card).toContainText('Which color should the button be?');
  await again.expectStatus('needs-answer');
  // The transcript points at it as well (snapshot of the tool call awaiting the decision).
  await expect(again.transcript.locator('[data-slot="decision-line"]')).toBeVisible();

  const reloaded = await again.armedCard('question');
  await reloaded.getByRole('radio', { name: /Red/ }).click();
  await reloaded.locator('[data-action="answer"]').click();
  await expect(again.assistantText('You chose: Red')).toBeVisible();
  await again.expectStatus('idle');
});
