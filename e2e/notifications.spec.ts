/**
 * Notifications (A.9, WP-20b §2.6; Phase 2 ADR-109, WP-38): the server picks the channel from the
 * windows' presence, the window shows it and plays the event's sound. A context with the
 * notification permission; `Notification` and `AudioContext` are wrapped by an init script that
 * records every toast and every started oscillator; focus and visibility of a window are switched
 * through `document.hasFocus()` / `document.visibilityState` (support/presence.ts – headless Edge
 * always reports a focused, visible page).
 * - Window in the background (not focused, hidden): "waiting for you" and "done" as Windows toast
 *   (Web Notification, tag = session, silent because the window plays its own sound: chime for the
 *   permission, pop for done); window title "(n) Parallax"; a click on the toast selects the
 *   session (also when another one is shown).
 * - Window in focus, another session shown: in-app hint with "Show session".
 */
import { ParallaxApp } from './support/app';
import { expect, test } from './support/fixtures';
import { clickLastToast, recordNotifications, setPresence, tones, toasts } from './support/presence';
import { connectNodeClient, nodeCommand } from './support/server';

test.use({ permissions: ['notifications'] });

/** First tone of the synthesized sounds (src/web/notifications/sounds.ts). */
const CHIME_HZ = 659.25;
const POP_HZ = 520;

test('window in the background: "waiting for you" and "done" arrive as Windows toasts with a sound; a click selects the session', async ({
  page,
  context,
  server,
}) => {
  await context.addInitScript(recordNotifications);
  const app = await new ParallaxApp(page, server).open();
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  const other = await app.newSession(await server.makeProject('toast-other'));
  const session = await app.newSession(await server.makeProject('toast'));
  await session.send('hello first');
  await expect(session.assistantText('Echo: hello first')).toBeVisible();
  // The fake's AI title follows the first turn.
  await expect(session.header.locator('h1')).toHaveText('Fake: hello first');
  const title = 'Fake: hello first';
  // The clicks so far were user interactions: the window may play sounds (WP-38 unlock).
  expect(await tones(page)).toEqual([]);

  await setPresence(page, { focused: false, visible: false });
  await session.send('fake:permission while away');
  await expect
    .poll(() => toasts(page))
    .toEqual([
      {
        title: `${title} – needs permission`,
        body: 'Click to show the session.',
        tag: session.key,
        // The window sounds itself (ADR-109): the Web Notification stays silent.
        silent: true,
      },
    ]);
  await expect(page).toHaveTitle('(1) Parallax');
  await expect.poll(async () => (await tones(page)).map((tone) => tone.frequency)).toContain(CHIME_HZ);

  // Answer (the window stays "in the background") → the turn ends unseen → "done".
  await (await session.armedCard('permission')).locator('[data-action="allow-once"]').click();
  await expect
    .poll(async () => (await toasts(page)).map((toast) => toast.title))
    .toEqual([`${title} – needs permission`, `${title} – done`]);
  await expect.poll(async () => (await tones(page)).map((tone) => tone.frequency)).toContain(POP_HZ);
  await expect(page).toHaveTitle('Parallax');

  // Another session in front, then the click on the toast brings the notified one back.
  await app.selectSession(other.key);
  expect(await app.selectedSessionKey()).toBe(other.key);
  await clickLastToast(page);
  await app.waitForSelection((key) => key === session.key);
  await expect(app.session(session.key).pane).toBeVisible();
});

test('window in focus showing another session: in-app hint with "Show session"', async ({
  page,
  context,
  server,
}) => {
  await context.addInitScript(recordNotifications);
  const app = await new ParallaxApp(page, server).open();
  const asking = await app.newSession(await server.makeProject('in-app-asking'));
  const shown = await app.newSession(await server.makeProject('in-app-shown'));
  expect(await app.selectedSessionKey()).toBe(shown.key);

  // The question comes from a turn started elsewhere (protocol client) while this window shows
  // the other session.
  const client = await connectNodeClient(server);
  try {
    await nodeCommand(client, {
      name: 'session.sendPrompt',
      entryId: asking.entryId,
      prompt: { text: 'fake:question from elsewhere' },
      priority: 'next',
    });
  } finally {
    client.socket.terminate();
  }
  const notice = app.notices().filter({ hasText: '– has a question' });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-tone', 'warning');
  await expect(page).toHaveTitle('(1) Parallax');
  expect(await toasts(page)).toEqual([]);
  // The in-app hint sounds as well (question: chime).
  await expect.poll(async () => (await tones(page)).map((tone) => tone.frequency)).toContain(CHIME_HZ);

  await notice.getByRole('button', { name: 'Show session' }).click();
  await app.waitForSelection((key) => key === asking.key);
  await expect(notice).toHaveCount(0);
  await expect(app.session(asking.key).card).toHaveAttribute('data-decision-kind', 'question');
});
