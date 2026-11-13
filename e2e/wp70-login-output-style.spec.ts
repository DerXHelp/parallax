/**
 * WP-70 against the FakeBackend:
 * - sign in from Parallax: `fake:auth-failed` → the sign-in error in the transcript carries "Sign
 *   in" → the small non-modal dialog waits (the fake sign-in page `https://login.parallax.invalid/…`
 *   only goes to the recording opener of the server – `link.open (fake): <url>`, never a browser) →
 *   the pasted code signs in ("Signed in (Max)") → the button at the error is gone;
 * - output style per project: header "…" → "Output style…" → a style of the list → the next turn
 *   (`fake:output-style`) reports it.
 * Own server (the sign-in state of the profile lives in it).
 */
import { logMessages } from './support/files';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp70' });

const LINK_OPEN = 'link.open (fake): ';
const FAKE_LOGIN = /^https:\/\/login\.parallax\.invalid\/oauth\/authorize\?code=true&state=fake-state-/;

test('a sign-in error → "Sign in" → dialog → pasted code → signed in; the hint is gone', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('login'));
  await session.send('fake:auth-failed');
  const signIn = session.transcript.locator('[data-slot="login-button"]');
  await expect(signIn).toHaveCount(1);
  await expect(session.transcript).toContainText('Claude Code needs a new sign-in');
  await signIn.click();

  const dialog = page.locator('[data-slot="login-dialog"]');
  await expect(dialog).toHaveAttribute('data-login-state', 'waiting');
  await expect(dialog).toContainText('The sign-in page is open in your browser');
  // Non-modal: no overlay over the window.
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  // The server opened the fake sign-in page through its recording opener – no browser, no window.open.
  await expect
    .poll(async () => (await logMessages(server)).filter((message) => message.startsWith(LINK_OPEN)).length)
    .toBe(1);
  const opened = (await logMessages(server)).find((message) => message.startsWith(LINK_OPEN)) ?? '';
  expect(opened.slice(LINK_OPEN.length)).toMatch(FAKE_LOGIN);

  // "Open link again" goes the same way (host command link.open).
  await dialog.locator('[data-action="login-open"]').click();
  await expect
    .poll(async () => (await logMessages(server)).filter((message) => message.startsWith(LINK_OPEN)).length)
    .toBe(2);
  // Nothing opened in the app's own browser either (no popup page).
  expect(page.context().pages()).toHaveLength(1);

  await dialog.getByRole('textbox', { name: 'Paste code' }).fill('fake-code-123');
  await dialog.locator('[data-action="login-submit"]').click();
  await expect(dialog).toHaveAttribute('data-login-state', 'done');
  await expect(dialog).toContainText('Signed in (Max)');
  // The hint at the error is gone (signed in after it).
  await expect(signIn).toHaveCount(0);
  await dialog.locator('[data-action="login-close"]').click();
  await expect(dialog).toHaveCount(0);
});

test('output style: header "…" → "Output style…" → the next turn reports the chosen style', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('style'));
  await session.send('Reply with exactly: OK');
  await session.expectStatus('idle');
  await session.headerAction('outputStyle');

  const dialog = page.locator('[data-slot="output-style-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'Applies to all sessions in this project (.claude\\settings.local.json)',
  );
  const current = dialog.getByRole('button', { name: 'Use output style “default”' });
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  const explanatory = dialog.getByRole('button', { name: 'Use output style “Explanatory”' });
  await explanatory.click();
  await expect(explanatory).toHaveAttribute('aria-pressed', 'true');
  await expect(current).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await session.send('fake:output-style');
  await expect(session.assistantText('Fake: output style Explanatory')).toBeVisible();
  await session.expectStatus('idle');
});
