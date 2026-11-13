/**
 * WP-67 (session info with tabs) against the FakeBackend (src/server/backend/fake/sessionInfo.ts):
 * - every tab shows data of the running fake CLI; MCP "Reconnect" turns the failed `fake-search`
 *   into connected; "Reload skills" brings `fresh-skill`; Export "Copy" (clipboard stubbed in the page
 *   – the machine's clipboard stays untouched) and "Save as file" (browser download with the CLI's
 *   file name);
 * - a sleeping session: the tab says "not running – start?", the start wakes it without a turn.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp67' });

/** Opens the tab `name` and waits until its first answer is there. */
async function openTab(dialog: Locator, name: string, state = 'ready'): Promise<Locator> {
  await dialog.getByRole('tab', { name, exact: true }).click();
  const panel = dialog.getByRole('tabpanel');
  const frame = panel.locator('[data-slot="session-info-section"]');
  await expect(frame).toHaveAttribute('data-state', state);
  await expect(frame).toHaveAttribute('aria-busy', 'false');
  return panel;
}

/** Replaces `navigator.clipboard.writeText` in the page by a recorder (`window.__copied`). */
async function stubClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          Reflect.set(window, '__copied', text);
          return Promise.resolve();
        },
      },
    });
  });
}

test('session info: every tab shows data; MCP reconnect, reload skills, export copy and save', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('info'));
  await session.send('hello info');
  await expect(session.assistantText('Echo: hello info')).toBeVisible();
  await session.expectStatus('idle');

  await session.headerAction('sessionInfo');
  const dialog = page.locator('[data-slot="session-info"]');
  await expect(dialog).toBeVisible();
  // The overview stays the default (and the place of the session id, phase2-lifecycle).
  await expect(dialog.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog).toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);

  // MCP: the failed server reconnects.
  let panel = await openTab(dialog, 'MCP');
  const search = panel.locator('[data-server="fake-search"]');
  await expect(search).toHaveAttribute('data-status', 'failed');
  await expect(search).toContainText('ENOENT');
  await expect(panel.locator('[data-server="fake-docs"]')).toHaveAttribute('data-status', 'connected');
  await search.locator('[data-action="mcp-reconnect"]').click();
  await expect(panel.locator('[data-slot="mcp-outcome"]')).toHaveText('fake-search reconnected.');
  await expect(search).toHaveAttribute('data-status', 'connected');

  panel = await openTab(dialog, 'Permissions');
  await expect(panel.locator('[data-behavior="allow"]')).toContainText('Read(src/**)');
  await expect(panel.locator('[data-behavior="ask"]')).toContainText('Bash(git push:*)');
  await expect(panel.locator('[data-behavior="deny"]')).toContainText('Bash(rm -rf:*)');

  // Skills: reload brings the new skill.
  panel = await openTab(dialog, 'Skills');
  await expect(panel.locator('[data-skill="release-notes"]')).toBeVisible();
  await expect(panel.locator('[data-skill="fresh-skill"]')).toHaveCount(0);
  await panel.locator('[data-action="reload-skills"]').click();
  await expect(panel.locator('[data-slot="skills-outcome"]')).toHaveText('Skills reloaded.');
  await expect(panel.locator('[data-skill="fresh-skill"]')).toBeVisible();

  panel = await openTab(dialog, 'CLAUDE.md');
  await expect(panel.locator('[data-slot="memory-files"]')).toContainText('Project memory');

  panel = await openTab(dialog, 'Hooks');
  await expect(panel.locator('[data-event="PreToolUse"]')).toBeVisible();

  panel = await openTab(dialog, 'Status');
  await expect(panel).toContainText('Session ID');
  await expect(panel).toContainText('Environment');

  // Export: copy and save.
  panel = await openTab(dialog, 'Export');
  await expect(panel.locator('[data-slot="export-preview"]')).toContainText('> hello info');
  await stubClipboard(page);
  await panel.locator('[data-action="export-copy"]').click();
  await expect(panel.locator('[data-slot="export-notice"]')).toHaveText('Conversation copied.');
  expect(await page.evaluate(() => String(Reflect.get(window, '__copied')))).toContain('> hello info');
  const download = page.waitForEvent('download');
  await panel.locator('[data-action="export-save"]').click();
  expect((await download).suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}-hello-info\.txt$/);

  // Reopened, the dialog shows the last tab again.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await session.headerAction('sessionInfo');
  await expect(dialog.getByRole('tab', { name: 'Export', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('session info of a sleeping session: "not running – start?" wakes it without a turn', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('info-sleep'));
  await session.send('hello sleepy');
  await expect(session.assistantText('Echo: hello sleepy')).toBeVisible();
  await session.expectStatus('idle');
  await session.headerAction('sleep');
  await session.expectStatus('sleeping');

  await session.headerAction('sessionInfo');
  const dialog = page.locator('[data-slot="session-info"]');
  const panel = await openTab(dialog, 'MCP', 'notRunning');
  await expect(panel.locator('[data-slot="session-info-not-running"]')).toContainText('The session is not running.');
  await panel.locator('[data-action="session-info-start"]').click();
  const frame = panel.locator('[data-slot="session-info-section"]');
  await expect(frame).toHaveAttribute('data-state', 'ready');
  await expect(panel.locator('[data-server="fake-docs"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await session.expectStatus('idle');
  // No turn ran: still the one answer.
  await expect(session.assistantText(/Echo:/)).toHaveCount(1);
});
