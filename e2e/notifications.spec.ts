/**
 * Notifications Phase 1 (A.9, WP-20b §2.6): the server picks the channel from the windows'
 * presence, the window shows it. A context with the notification permission; `Notification` is
 * wrapped by an init script that records every toast; focus and visibility of a window are
 * switched through `document.hasFocus()` / `document.visibilityState` (headless Edge always
 * reports a focused, visible page).
 * - Window in the background (not focused, hidden): "waiting for you" and "done" as Windows toast
 *   (Web Notification, tag = session); window title "(n) Parallax".
 * - Window in focus, another session shown: in-app hint with "Show session".
 */
import type { Page } from '@playwright/test';
import { ParallaxApp } from './support/app';
import { connectNodeClient, nodeCommand } from './support/server';
import { expect, test } from './support/fixtures';

test.use({ permissions: ['notifications'] });

interface Recorded {
  title: string;
  body: string | undefined;
  tag: string | undefined;
}

/** Init script: records toasts, lets the test switch focus/visibility of the window. */
function recordNotifications(): void {
  const w = window as unknown as {
    __e2eFocused: boolean;
    __e2eVisible: boolean;
    __e2eToasts: Recorded[];
    __e2eToastObjects: Notification[];
  };
  w.__e2eFocused = true;
  w.__e2eVisible = true;
  w.__e2eToasts = [];
  w.__e2eToastObjects = [];
  const Real = window.Notification;
  class Recording extends Real {
    constructor(title: string, options?: NotificationOptions) {
      w.__e2eToasts.push({ title, body: options?.body, tag: options?.tag });
      super(title, options);
      w.__e2eToastObjects.push(this);
    }
  }
  Object.defineProperty(window, 'Notification', { value: Recording, configurable: true, writable: true });
  Document.prototype.hasFocus = function hasFocus() {
    return w.__e2eFocused;
  };
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (w.__e2eVisible ? 'visible' : 'hidden'),
  });
}

/** Moves the window to the background (or back) and lets the presence reach the server. */
async function setPresence(page: Page, presence: { focused: boolean; visible: boolean }): Promise<void> {
  await page.evaluate((next) => {
    const w = window as unknown as { __e2eFocused: boolean; __e2eVisible: boolean };
    w.__e2eFocused = next.focused;
    w.__e2eVisible = next.visible;
    window.dispatchEvent(new Event(next.focused ? 'focus' : 'blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, presence);
  // presence is debounced 250 ms (connection.ts)
  await page.waitForTimeout(700);
}

function toasts(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __e2eToasts: Recorded[] }).__e2eToasts);
}

test('window in the background: "waiting for you" and "done" arrive as Windows toasts', async ({
  page,
  context,
  server,
}) => {
  await context.addInitScript(recordNotifications);
  const app = await new ParallaxApp(page, server).open();
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');
  const session = await app.newSession(await server.makeProject('toast'));
  await session.send('hello first');
  await expect(session.assistantText('Echo: hello first')).toBeVisible();
  // The fake's AI title follows the first turn.
  await expect(session.header.locator('h1')).toHaveText('Fake: hello first');
  const title = 'Fake: hello first';

  await setPresence(page, { focused: false, visible: false });
  await session.send('fake:permission while away');
  await expect
    .poll(() => toasts(page))
    .toEqual([
      { title: `${title} – needs permission`, body: 'Click to show the session.', tag: session.key },
    ]);
  await expect(page).toHaveTitle('(1) Parallax');

  // Answer (the window stays "in the background") → the turn ends unseen → "done".
  await (await session.armedCard('permission')).locator('[data-action="allow-once"]').click();
  await expect
    .poll(async () => (await toasts(page)).map((toast) => toast.title))
    .toEqual([`${title} – needs permission`, `${title} – done`]);
  await expect(page).toHaveTitle('Parallax');
  // Clicking the toast brings the session to the front and marks the notification as seen.
  await page.evaluate(() => {
    const list = (window as unknown as { __e2eToastObjects: Notification[] }).__e2eToastObjects;
    list.at(-1)?.dispatchEvent(new Event('click', { cancelable: true }));
  });
  expect(await app.selectedSessionKey()).toBe(session.key);
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

  await notice.getByRole('button', { name: 'Show session' }).click();
  await app.waitForSelection((key) => key === asking.key);
  await expect(notice).toHaveCount(0);
  await expect(app.session(asking.key).card).toHaveAttribute('data-decision-kind', 'question');
});
