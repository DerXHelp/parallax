/**
 * Phase-2 verification "many sessions" (Plan "Verifikation", WP-30 §2.11) on the FakeBackend:
 * - three sessions in three temp folders work at the same time (`fake:slow`); the sidebar shows
 *   them flat and grouped by project (case-insensitive folder key – a session created for the same
 *   folder with another spelling joins its group), two-line entries (path tail, model, context);
 * - the status chain working → needs-permission → working → done + unread → idle at one session
 *   (`fake:bash`, the window in the background makes the finished turn unread, selecting the
 *   session marks it read).
 * Own server per test: the sidebar must contain exactly the sessions of the test.
 */
import type { Page } from '@playwright/test';
import { ParallaxApp, type SessionView } from './support/app';
import { expect, keepServerLog, test } from './support/fixtures';
import { recordNotifications, setPresence } from './support/presence';
import { startE2eServer, type E2eServer } from './support/server';

/** `fake:slow`: 100 deltas of 200 ms (≈ 20 s at speed 1). */
const SLOW = 'fake:slow';

let own: E2eServer | null = null;

test.afterEach(async () => {
  await own?.stop(keepServerLog(test.info()));
  own = null;
});

test('three sessions in three folders work in parallel; the sidebar shows them flat and grouped', async ({
  page,
}) => {
  own = await startE2eServer({ label: 'sessions' });
  const app = await new ParallaxApp(page, own).open();
  const folders = [
    await own.makeProject('alpha-api'),
    await own.makeProject('beta-web'),
    await own.makeProject('gamma-docs'),
  ];
  const sessions: SessionView[] = [];
  for (const cwd of folders) sessions.push(await app.newSession(cwd));
  // First turns: model and context are known afterwards (row line 2).
  for (const [index, session] of sessions.entries()) {
    await app.selectSession(session.key);
    await session.send(`hello ${String(index + 1)}`);
    await expect(session.assistantText(`Echo: hello ${String(index + 1)}`)).toBeVisible();
  }

  // All three at once.
  for (const session of sessions) {
    await app.selectSession(session.key);
    await session.send(SLOW);
    await expect(session.assistantText(/Line 2 of a slow answer/)).toBeVisible();
  }
  for (const session of sessions)
    await expect(app.rowStatus(session.key)).toHaveAttribute('data-status', 'working');
  await expect(app.sidebar()).toHaveAttribute('data-view', 'flat');
  expect(new Set(await app.rowKeys())).toEqual(new Set(sessions.map((s) => s.key)));

  // Two-line entries: line 2 = last path segments, short model name, context fill.
  for (const [index, session] of sessions.entries()) {
    const details = app.row(session.key).locator('[data-slot="row-details"]');
    await expect(details.locator('[data-slot="row-path"]')).toHaveText(pathTail(folders[index] ?? ''));
    await expect(details.locator('[data-slot="row-model"]')).not.toBeEmpty();
    await expect(details.locator('[data-slot="row-context"]')).toHaveAttribute(
      'data-level',
      /normal|warning|danger/,
    );
  }

  // Grouped by project: one group per folder, the rows without the path (the group names it).
  await page.locator('[data-slot="sidebar-mode"]').click();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'grouped');
  const groups = app.sidebar().getByRole('group');
  await expect(groups).toHaveCount(3);
  await expect(app.row(sessions[0]?.key ?? '').locator('[data-slot="row-path"]')).toHaveCount(0);

  // "New session in this project…" of a group: the dialog is pre-filled with its folder (WP-36/35).
  const first = groups.filter({ has: app.row(sessions[0]?.key ?? '') });
  await first.hover();
  await first.locator('[data-action="new-session-here"]').click();
  const dialog = page.locator('[data-slot="new-session-dialog"]');
  await expect(dialog.locator('input[name="cwd"]')).toHaveValue(folders[0] ?? '');
  // The same folder in another spelling (Windows paths are case-insensitive) joins the group.
  await dialog.locator('input[name="cwd"]').fill((folders[0] ?? '').toUpperCase());
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  const fourth = await app.waitForSelection((key) => key !== null && !sessions.some((s) => s.key === key));
  await expect(groups).toHaveCount(3);
  await expect(groups.filter({ has: app.row(fourth) }).locator('[data-session-row]')).toHaveCount(2);
  // The sidebar keeps the mode (localStorage) over a reload.
  await page.reload();
  await app.waitConnected();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'grouped');

  // The slow turns end by themselves.
  for (const session of sessions) {
    await expect(app.rowStatus(session.key)).not.toHaveAttribute('data-status', 'working', {
      timeout: 60_000,
    });
  }
});

/** Records every `data-status` of the session header (MutationObserver – no transition is missed). */
async function recordHeaderStatus(page: Page, sessionKey: string): Promise<void> {
  await page.evaluate((key) => {
    const header = document.querySelector(`section[data-session-key="${key}"] [data-slot="session-header"]`);
    const log: string[] = [];
    (window as unknown as { __e2eStatus: string[] }).__e2eStatus = log;
    if (header === null) return;
    const push = () => {
      const value = header.getAttribute('data-status') ?? '';
      if (log.at(-1) !== value) log.push(value);
    };
    push();
    new MutationObserver(push).observe(header, { attributes: true, attributeFilter: ['data-status'] });
  }, sessionKey);
}

function statusLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __e2eStatus: string[] }).__e2eStatus);
}

/** Status kinds of `log` in order, each kept once per run (subsequence check). */
function containsInOrder(log: readonly string[], expected: readonly string[]): boolean {
  let at = 0;
  for (const value of log) if (value === expected[at]) at += 1;
  return at === expected.length;
}

test('status chain at one session: working → needs-permission → working → done + unread → idle', async ({
  page,
  context,
}) => {
  own = await startE2eServer({ label: 'chain' });
  await context.addInitScript(recordNotifications);
  const app = await new ParallaxApp(page, own).open();
  const other = await app.newSession(await own.makeProject('chain-other'));
  const session = await app.newSession(await own.makeProject('chain'));
  await session.send('hello chain');
  await expect(session.assistantText('Echo: hello chain')).toBeVisible();
  await session.expectStatus('idle');

  // The window in the background: the end of the turn is not seen → unread ("done").
  await setPresence(page, { focused: false, visible: false });
  await recordHeaderStatus(page, session.key);
  await session.send('fake:bash create a folder');
  const card = await session.armedCard('permission');
  await session.expectStatus('needs-permission');
  await card.locator('[data-action="allow-once"]').click();
  await expect(session.assistantText('Done: the folder fake-dir exists now.')).toBeVisible();
  await session.expectStatus('done');
  const chain = ['working', 'needs-permission', 'working', 'done'];
  await expect.poll(async () => containsInOrder(await statusLog(page), chain)).toBe(true);
  expect((await statusLog(page)).at(-1)).toBe('done');
  await expect(app.row(session.key)).toContainText('Unread');

  // Back in front, but showing another session: still unread.
  await app.selectSession(other.key);
  await setPresence(page, { focused: true, visible: true });
  await expect(app.rowStatus(session.key)).toHaveAttribute('data-status', 'done');
  // Selecting it marks it read → idle.
  await app.selectSession(session.key);
  await session.expectStatus('idle');
  await expect(app.rowStatus(session.key)).toHaveAttribute('data-status', 'idle');
  await expect(app.row(session.key)).not.toContainText('Unread');
});

/** Last two path segments as the sidebar shows them (`pathTail(cwd, 2)`). */
function pathTail(cwd: string): string {
  return cwd
    .split('\\')
    .filter((part) => part !== '')
    .slice(-2)
    .join('\\');
}
