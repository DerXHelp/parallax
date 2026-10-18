/**
 * Phase-2 navigation (WP-35, ADR-116/118, L9/L12 on the page side): quick switcher Ctrl+K with
 * fuzzy search, Alt+1…9 (visible order), Alt+N and "Waiting for you (n)" (next waiting session,
 * cyclic), rename with F2 and double click, the context menu (pin, archive → archive view →
 * restore; an archived session is read-only – the composer has no field and the server answers
 * SESSION_ARCHIVED), "Open in new window" (a new page on `#session=` with its own clientId).
 * Own server per test: the sidebar order must contain exactly the sessions of the test.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { ParallaxApp, type SessionView } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { connectNodeClient, startE2eServer, type E2eServer } from './support/server';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

/** A new session whose first turn gave it the AI title "Fake: <prompt>". */
async function titledSession(app: ParallaxApp, server: E2eServer, name: string): Promise<SessionView> {
  const session = await app.newSession(await server.makeProject(name));
  await session.send(`hello ${name}`);
  await expect(session.header.locator('h1')).toHaveText(`Fake: hello ${name}`);
  return session;
}

/** A new session that waits for an answer (`fake:question`). */
async function waitingSession(app: ParallaxApp, server: E2eServer, name: string): Promise<SessionView> {
  const session = await app.newSession(await server.makeProject(name));
  await session.send(`fake:question ${name}`);
  await session.armedCard('question');
  await session.expectStatus('needs-answer');
  return session;
}

test('keyboard: Ctrl+K picks by fuzzy search, Alt+1…9 the visible order, Alt+N and "Waiting for you (n)" cycle', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'nav-keys' });
  const app = await new ParallaxApp(page, own).open();
  const zebra = await titledSession(app, own, 'zebra');
  const yak = await titledSession(app, own, 'yak');
  const first = await waitingSession(app, own, 'wait-one');
  const second = await waitingSession(app, own, 'wait-two');

  // Ctrl+K: fuzzy ("zbr" → "Fake: hello zebra"), Enter opens it.
  await page.keyboard.press('Control+k');
  const switcher = page.locator('[data-slot="quick-switcher"]');
  await expect(switcher).toBeVisible();
  await page.keyboard.type('zbr');
  await expect(switcher.getByRole('option')).toHaveCount(1);
  await expect(switcher.getByRole('option')).toContainText('Fake: hello zebra');
  await page.keyboard.press('Enter');
  await expect(switcher).toHaveCount(0);
  await app.waitForSelection((key) => key === zebra.key);

  // Alt+1…9 = the n-th row of the visible list (waiting first, then by activity).
  const order = await app.rowKeys();
  expect(order.slice(0, 2).sort()).toEqual([first.key, second.key].sort());
  expect(order).toContain(yak.key);
  for (const n of [3, 1, 4]) {
    await page.keyboard.press(`Alt+${String(n)}`);
    await app.waitForSelection((key) => key === order[n - 1]);
  }

  // "Waiting for you (2)" and Alt+N: the next waiting session after the selection, cyclically.
  await app.selectSession(yak.key);
  const waitingButton = page.locator('[data-action="next-waiting"]');
  await expect(waitingButton).toHaveText('Waiting for you (2)');
  await waitingButton.click();
  const firstWaiting = await app.waitForSelection((key) => key === first.key || key === second.key);
  const otherWaiting = firstWaiting === first.key ? second.key : first.key;
  await page.keyboard.press('Alt+n');
  await app.waitForSelection((key) => key === otherWaiting);
  await page.keyboard.press('Alt+n');
  await app.waitForSelection((key) => key === firstWaiting);

  // Answering one leaves one waiting.
  const view = app.session(firstWaiting);
  const card = await view.armedCard('question');
  await card.getByRole('radio').first().click();
  await card.locator('[data-action="answer"]').click();
  await expect(waitingButton).toHaveText('Waiting for you (1)');
});

test('rename (F2, double click), context menu: pin, archive → archive view → restore; archived = read-only', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'nav-menu' });
  const app = await new ParallaxApp(page, own).open();
  const older = await titledSession(app, own, 'older');
  const newer = await titledSession(app, own, 'newer');

  // F2 on the focused row edits the title inline; Enter saves (server: session.rename).
  await app.row(older.key).focus();
  await page.keyboard.press('F2');
  const field = page.locator('[data-slot="rename-field"]');
  await expect(field).toBeFocused();
  await field.fill('Renamed with F2');
  await page.keyboard.press('Enter');
  await expect(app.row(older.key).locator('[data-slot="row-title"]')).toHaveText('Renamed with F2');
  // Double click on the header title; Esc cancels.
  await app.selectSession(newer.key);
  await newer.header.locator('h1').dblclick();
  const headerField = newer.header.locator('[data-slot="rename-field"]');
  await expect(headerField).toBeFocused();
  await headerField.fill('never saved');
  await page.keyboard.press('Escape');
  await expect(newer.header.locator('h1')).toHaveText('Fake: hello newer');

  // Pin: the older session moves to the top (above the most recent one) and shows the pin.
  await newer.send('hello again');
  await expect(newer.assistantText('Echo: hello again')).toBeVisible();
  await expect.poll(async () => (await app.rowKeys())[0]).toBe(newer.key);
  await (await app.rowMenu(older.key)).locator('[data-action="pin"]').click();
  await expect(app.row(older.key).locator('[data-slot="row-pinned"]')).toBeVisible();
  await expect.poll(async () => (await app.rowKeys())[0]).toBe(older.key);

  // Archive the selected session: it leaves the list, the pane is read-only.
  await (await app.rowMenu(newer.key)).locator('[data-action="archive"]').click();
  await expect(app.row(newer.key)).toHaveCount(0);
  await expect(newer.pane.locator('[data-slot="pane-archived"]')).toBeVisible();
  await expect(newer.composerRoot).toHaveAttribute('data-reason', 'archived');
  await expect(newer.composer).toHaveCount(0);
  // The server refuses a prompt to an archived session anyway (SESSION_ARCHIVED).
  await expect(sendPromptOver(own, newer.entryId)).rejects.toThrow('SESSION_ARCHIVED');

  // Archive view → restore.
  const toggle = page.locator('[data-slot="archive-toggle"]');
  await expect(toggle).toHaveText('Archive (1)');
  await toggle.click();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'archive');
  await expect(app.row(newer.key)).toBeVisible();
  await page.locator(`[data-row="${newer.key}"] [data-action="restore"]`).click();
  await expect(app.row(newer.key)).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to the sessions' }).click();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'flat');
  await expect(app.row(newer.key)).toBeVisible();
  await expect(newer.pane.locator('[data-slot="pane-archived"]')).toHaveCount(0);
  await newer.send('after the restore');
  await expect(newer.assistantText('Echo: after the restore')).toBeVisible();
});

async function sendPromptOver(server: E2eServer, entryId: string): Promise<void> {
  const client = await connectNodeClient(server);
  try {
    const cmdId = randomUUID();
    client.send({
      type: 'cmd',
      cmdId,
      cmd: { name: 'session.sendPrompt', entryId, prompt: { text: 'still there?' }, priority: 'next' },
    });
    const ack = await client.next('ack', (m) => m.cmdId === cmdId, 30_000);
    if (!ack.ok) throw new Error(ack.error.code);
  } finally {
    client.socket.terminate();
  }
}

/** The clientId of the first `clientHello` a page sends (recorded from its WebSocket frames). */
function recordClientId(page: Page): Promise<string> {
  return new Promise((resolve) => {
    page.on('websocket', (socket) => {
      socket.on('framesent', (frame) => {
        const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
        const message: unknown = JSON.parse(text);
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'clientHello' &&
          'clientId' in message &&
          typeof message.clientId === 'string'
        ) {
          resolve(message.clientId);
        }
      });
    });
  });
}

test('"Open in new window": a new page on #session= with its own clientId (ADR-116, L9 page side)', async ({
  page,
  context,
}) => {
  own = await startE2eServer({ label: 'nav-window' });
  const firstClient = recordClientId(page);
  const app = await new ParallaxApp(page, own).open();
  const shown = await titledSession(app, own, 'shown');
  const target = await titledSession(app, own, 'target');
  await app.selectSession(shown.key);

  const popup = context.waitForEvent('page');
  const opened = new Promise<{ page: Page; clientId: Promise<string> }>((resolve) => {
    context.once('page', (next) => {
      resolve({ page: next, clientId: recordClientId(next) });
    });
  });
  await (await app.rowMenu(target.key)).locator('[data-action="openWindow"]').click();
  await popup;
  const { page: second, clientId: secondClient } = await opened;
  await expect.poll(() => second.url()).toContain(`#session=${target.entryId}`);
  const other = new ParallaxApp(second, own);
  await other.waitConnected();
  await expect(other.session(target.key).pane).toBeVisible();
  await expect(other.session(target.key).header.locator('h1')).toHaveText('Fake: hello target');
  // noopener (ADR-116): no shared opener, an own clientId – no twin toasts (R3-15).
  expect(await second.evaluate(() => window.opener === null)).toBe(true);
  expect(await secondClient).not.toBe(await firstClient);
  // The first window keeps its own selection.
  expect(await app.selectedSessionKey()).toBe(shown.key);
  await second.close();
});
