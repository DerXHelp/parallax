/**
 * WP-65 (overview) against the FakeBackend:
 * - §1.1 the line under the name: Parallax's words while a turn works (no Remote Control), the turn
 *   summary afterwards; with Remote Control the CLI's live sentence and its summary (`fake:summary`);
 *   the same line in the header;
 * - §1.4 the limit bar fills from the usage query alone (first round 10 s after the spawn, no
 *   `rate_limit` event), its tooltip says when it resets;
 * - §1.2 "Since you were last here": a turn started elsewhere (protocol client) while another
 *   session was shown → the card with the turn, the changed files and the summary; jump and close;
 * - §1.3 the auto title; a custom title stays; "Generate title again";
 * - §1.5 "Move to background" on the running Bash row, "Move all to background" + Ctrl+B in the
 *   composer (`fake:long-bash`).
 * The default-browser links (§1.6b) are covered by wp64-remote-control.spec.ts ("Open in the Claude
 * app" → `link.open`). Own server for the file: the limit bar must come from the usage query.
 */
import {
  FAKE_LONG_BASH_MOVED,
  FAKE_SUMMARY_DETAIL,
  FAKE_SUMMARY_SENTENCES,
} from '../src/server/backend/fake/overview';
import type { ParallaxApp, SessionView } from './support/app';
import { expect, test } from './support/fixtures';
import { connectNodeClient, nodeCommand } from './support/server';

test.use({ ownServer: 'wp65' });

/** The fallback summary of `fake:summary` (first line of the answer without Markdown). */
const FALLBACK_SUMMARY = 'Summary: the fake project has three files and no open problems.';
/** The fallback summary of `fake:files`. */
const FILES_SUMMARY = 'I read, wrote and changed files in the fake workspace:';

function rowLine(app: ParallaxApp, session: SessionView) {
  return app.row(session.key).locator('[data-slot="session-line"]');
}

test('line under the name: Parallax words, summary, CLI sentence with Remote Control; header; limit bar from the usage query', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('line'));
  const line = rowLine(app, session);
  const header = session.pane.locator('[data-slot="header-line"]');

  // Without Remote Control: Parallax's words for the running tool, then the fallback summary.
  await session.send('fake:summary');
  await expect(line).toHaveText(/^Reading .*notes\.md$/);
  await expect(header).toHaveText(/^Reading .*notes\.md$/);
  await session.expectStatus('idle');
  await expect(line).toHaveAttribute('data-line', 'summary');
  await expect(line).toHaveText(FALLBACK_SUMMARY);
  await expect(header).toHaveText(FALLBACK_SUMMARY);
  await expect(header).toHaveAttribute('title', FALLBACK_SUMMARY);
  await expect(line).not.toHaveAttribute('data-attention', 'true');

  // The usage query fills the limit bar without any rate_limit event (fake account: 8 %, 3 h).
  const bar = page.locator('[data-slot="account-limits"] [data-limit="five_hour"]');
  await expect(bar.locator('[role="meter"]')).toHaveAttribute('aria-valuenow', '8', { timeout: 30_000 });
  await bar.hover();
  await expect(page.getByRole('tooltip')).toHaveText(/^8% used · resets in [23] hours$/);
  await page.mouse.move(0, 0);

  // With Remote Control: the CLI's live sentence, then its turn summary.
  await session.headerAction('remoteControl');
  await expect(session.pane.locator('[data-slot="header-remote"]')).toHaveAttribute('data-remote-state', 'connected');
  await session.send('fake:summary again');
  await expect(line).toHaveText(FAKE_SUMMARY_SENTENCES[0]);
  await expect(line).toHaveText(FAKE_SUMMARY_SENTENCES[1]);
  await session.expectStatus('idle');
  await expect(line).toHaveText(FAKE_SUMMARY_DETAIL);
  await expect(line).toHaveAttribute('data-line', 'summary');
  await expect(header).toHaveText(FAKE_SUMMARY_DETAIL);
});

test('"Since you were last here": a turn while another session was shown – turn, files, summary; jump, close', async ({
  app,
  server,
}) => {
  const away = await app.newSession(await server.makeProject('away'));
  await away.send('hello away');
  await away.expectStatus('idle');
  // Another session is shown: `away` was last seen now.
  const shown = await app.newSession(await server.makeProject('shown'));
  await expect(shown.pane).toBeVisible();

  const client = await connectNodeClient(server);
  try {
    await nodeCommand(client, {
      name: 'session.sendPrompt',
      entryId: away.entryId,
      prompt: { text: 'fake:files from elsewhere' },
      priority: 'next',
    });
  } finally {
    client.socket.terminate();
  }
  await expect(rowLine(app, away)).toHaveText(FILES_SUMMARY);

  await app.selectSession(away.key);
  const card = away.pane.getByRole('region', { name: 'Since you were last here' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('1 turn');
  const files = card.locator('[data-slot="since-files"]');
  await expect(files).toContainText('2 changed files:');
  await expect(away.fileLink(files, 'new-file.txt')).toHaveCount(1);
  await expect(away.fileLink(files, 'app.ts')).toHaveCount(1);
  await expect(card).toContainText(FILES_SUMMARY);
  await card.getByRole('button', { name: 'To the first new message' }).click();
  await expect(away.userMessages().filter({ hasText: 'fake:files from elsewhere' })).toBeInViewport();
  await card.getByRole('button', { name: 'Close the summary' }).click();
  await expect(card).toHaveCount(0);
});

test('auto title after the first turn; a custom title stays; "Generate title again"', async ({ app, server, page }) => {
  const session = await app.newSession(await server.makeProject('title'));
  await session.send('hello title');
  const title = session.header.locator('h1');
  await expect(title).toHaveText('Fake: hello title');

  // Renamed by the user: later turns keep the custom title.
  await title.dblclick();
  const field = session.header.locator('[data-slot="rename-field"]');
  await expect(field).toBeFocused();
  await field.fill('My own title');
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('My own title');
  await session.send('second prompt');
  await expect(session.assistantText('Echo: second prompt')).toBeVisible();
  await session.expectStatus('idle');
  await expect(title).toHaveText('My own title');

  // "Generate title again" from the row menu: a new AI title.
  await app.rowAction(session.key, 'regenerateTitle');
  await expect(title).toHaveText('Fake (new): hello title');
  await expect(app.row(session.key).locator('[data-slot="row-title"]')).toHaveText('Fake (new): hello title');
});

test('"Move to background" on the running Bash row; "Move all to background" and Ctrl+B in the composer', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('background'));
  const moveAll = session.composerRoot.locator('[data-action="background-all"]');
  await expect(moveAll).toHaveCount(0);

  // The row button of the running command.
  await session.send('fake:long-bash');
  await expect(moveAll).toBeVisible();
  await session.expandSteps();
  const button = session.toolCall('Bash').locator('[data-action="background"]');
  await expect(button).toHaveAccessibleName('Move “Run the test suite” to the background');
  await button.click();
  await expect(session.assistantText(FAKE_LONG_BASH_MOVED)).toHaveCount(1);
  // The turn goes on and ends; the command keeps running as a background task (task panel). Whether
  // the CLI counts a moved shell in `background_tasks_changed` (status "background") is a live check.
  await session.expectStatus('idle');
  await expect(moveAll).toHaveCount(0);
  await expect(session.toolCall('Bash').locator('[data-action="background"]')).toHaveCount(0);
  const tasks = (await session.openPanel('tasks')).locator('[data-slot="tasks-panel"] [data-slot="task-row"]');
  await expect(tasks.filter({ hasText: 'Run the test suite' })).toHaveCount(1);
  await session.panelButton('tasks').click();
  await expect(session.sidePanel).toHaveCount(0);

  // Ctrl+B with the focus in the message field moves everything that runs in the foreground.
  await session.send('fake:long-bash once more');
  await expect(moveAll).toBeVisible();
  await session.composer.focus();
  await page.keyboard.press('Control+b');
  await expect(session.assistantText(FAKE_LONG_BASH_MOVED)).toHaveCount(2);
  await expect(moveAll).toHaveCount(0);
});
