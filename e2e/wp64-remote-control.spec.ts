/**
 * WP-64 Remote Control against the FakeBackend (fake bridge, links `https://claude.ai/code/
 * session_fake…`):
 * - on from the header menu → phone icon in the header and in the sidebar row;
 * - `fake:remote-prompt` → the prompt typed "in the Claude app" with its hint and its answer;
 * - `fake:remote-permission` → the approval is answered "in the app": the card goes away by itself,
 *   the tool row says "Answered in the Claude app";
 * - `fake:remote-fail` → warning state with the readable error;
 * - a server restart keeps the wish and the link (the dormant session shows "connects when the
 *   session starts", the next prompt reattaches – "Open in the Claude app" opens the same link).
 * The idle sleep (minimum 5 minutes) is covered in the engine test (remoteControl.integration.test.ts).
 * Own server per test (the restart needs its own home).
 */
import type { Locator, Page } from '@playwright/test';
import { chooseMenuItem, ParallaxApp, type SessionView } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { startE2eServer, type E2eServer } from './support/server';

const FAKE_LINK = /^https:\/\/claude\.ai\/code\/session_fake[0-9a-f]{20}$/;

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

/** window.open only records the links (the test never leaves the app). */
function recordOpenedLinks(): void {
  const opened: string[] = [];
  window.__e2eOpened = opened;
  window.open = (url?: string | URL) => {
    opened.push(String(url ?? ''));
    return null;
  };
}

function remoteButton(session: SessionView): Locator {
  return session.pane.locator('[data-slot="header-remote"]');
}

/** "Open in the Claude app" from the header's Remote Control menu → the recorded link. */
async function openedLink(page: Page, session: SessionView): Promise<string> {
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await remoteButton(session).click();
  await chooseMenuItem(page.getByRole('menu').locator('[data-action="openRemote"]'));
  const opened = await page.evaluate(() => window.__e2eOpened ?? []);
  const last = opened.at(-1);
  if (last === undefined) throw new Error('no link opened');
  return last;
}

async function connectedSession(app: ParallaxApp, server: E2eServer, name: string): Promise<SessionView> {
  const session = await app.newSession(await server.makeProject(name));
  await session.send(`hello ${name}`);
  await session.expectStatus('idle');
  await expect(remoteButton(session)).toHaveCount(0);
  await session.headerAction('remoteControl');
  await expect(remoteButton(session)).toHaveAttribute('data-remote-state', 'connected');
  return session;
}

test('on: icons in header and row; a prompt and an approval from the Claude app; a failed bridge', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'remote' });
  const app = await new ParallaxApp(page, own).open();
  const session = await connectedSession(app, own, 'remote');
  await expect(remoteButton(session)).toHaveAccessibleName('Remote Control: connected – open in the Claude app');
  await expect(app.row(session.key).locator('[data-slot="row-remote"]')).toHaveAttribute(
    'data-remote-state',
    'connected',
  );

  // A prompt typed in the app: its own hint, the answer follows.
  await session.send('fake:remote-prompt Wie spät ist es?');
  const fromApp = session.userMessages().filter({ has: page.locator('[data-slot="user-remote"]') });
  await expect(fromApp).toHaveCount(1);
  await expect(fromApp).toContainText('Wie spät ist es?');
  await expect(fromApp.locator('[data-slot="user-remote"]')).toHaveText('From the Claude app');
  await expect(session.assistantText('From the app: Wie spät ist es?')).toBeVisible();
  // The own prompt shows once (its echo is dropped).
  await expect(session.userMessages().filter({ hasText: 'fake:remote-prompt' })).toHaveCount(1);
  await session.expectStatus('idle');

  // An approval answered in the app: the card goes away by itself, the tool ran.
  await session.send('fake:remote-permission');
  await expect(session.card).toHaveAttribute('data-decision-kind', 'permission');
  await expect(session.card).toHaveCount(0, { timeout: 15_000 });
  await expect(session.assistantText('handy.txt was written (approved in the Claude app).')).toBeVisible();
  await session.expectStatus('idle');
  await session.expandSteps();
  await expect(session.toolCall('Write')).toContainText('Answered in the Claude app');

  // The bridge fails for good: warning colour and the readable error.
  await session.send('fake:remote-fail');
  await expect(remoteButton(session)).toHaveAttribute('data-remote-state', 'failed');
  await expect(remoteButton(session)).toHaveAccessibleName(/connection failed or was lost/);
  await expect(app.row(session.key).locator('[data-slot="row-remote"]')).toHaveAttribute(
    'data-remote-state',
    'failed',
  );
});

test('server restart: the wish and the link stay – the next start reattaches to the same remote session', async ({
  page,
}) => {
  await page.context().addInitScript(recordOpenedLinks);
  const first = await startE2eServer({ label: 'remote-restart' });
  own = first;
  const app = await new ParallaxApp(page, first).open();
  const session = await connectedSession(app, first, 'restart');
  const link = await openedLink(page, session);
  expect(link).toMatch(FAKE_LINK);

  await first.requestShutdown();
  await first.assertCleanExit();
  const second = await startE2eServer({ label: 'remote-restart', reuse: first });
  own = second;
  const again = await new ParallaxApp(page, second).open(`session=${session.key}`);
  const view = again.session(session.key);
  await view.expectStatus('sleeping');
  await expect(remoteButton(view)).toHaveAccessibleName('Remote Control: connects when the session starts');
  // Dormant: no live bridge – the row shows no icon.
  await expect(again.row(session.key).locator('[data-slot="row-remote"]')).toHaveCount(0);

  await view.send('hello after the restart');
  await expect(remoteButton(view)).toHaveAttribute('data-remote-state', 'connected');
  expect(await openedLink(page, view)).toBe(link);
});
