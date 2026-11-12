/**
 * Phase-3 verification "tasks" (WP-60 E2E 6; WP-51/52/55/58): a background agent (`fake:background`)
 * in the side panel tab "Tasks" with its progress summary, "Stop" ends it (`stopped`); without a
 * turn the composer offers a plain "Send" and no Stop (B18); the
 * composer's Stop ends the turn while the background agent keeps running; `fake:todo` pins the
 * to-do list as a strip above the composer.
 * Own server; 1600 px wide (the side panel next to the transcript).
 */
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'p3tasks', viewport: { width: 1600, height: 900 } });

const STARTED = 'A background agent is working on it';

test('background agent: the panel shows its summary; "Stop" ends it as stopped', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('background'));
  await session.send('fake:background');
  await expect(session.assistantText(STARTED)).toBeVisible();
  // The header counts the running agent.
  await expect(session.panelButton('tasks').locator('[data-slot="header-panel-count"]')).toHaveText('1');
  // B18: the launch turn ended and only the agent works – a plain "Send", no Stop in the composer.
  await expect(session.composerRoot).toHaveAttribute('data-mode', 'idle');
  await expect(session.composerRoot.locator('[data-action="stop"]')).toHaveCount(0);

  const panel = (await session.openPanel('tasks')).locator('[data-slot="tasks-panel"]');
  const row = panel.locator('[data-slot="task-row"]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(row).toContainText('Fake background research');
  await expect(row.locator('[data-slot="task-summary"]')).toHaveText('Reading the project files');
  await expect(row.locator('[data-slot="task-output"] [data-slot="file-link"]')).toContainText('.output');

  await row.locator('[data-slot="task-stop"]').click();
  await expect(row).toHaveAttribute('data-state', 'finished');
  await expect(row.locator('[data-slot="task-status"]')).toContainText('Stopped');
  await expect(row.locator('[data-slot="task-stop"]')).toHaveCount(0);
  await session.expectStatus('idle');
  await expect(session.panelButton('tasks').locator('[data-slot="header-panel-count"]')).toHaveCount(0);
});

test("the composer's Stop ends the turn; the background agent keeps running", async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('stop-turn'));
  await session.send('fake:background');
  await expect(session.assistantText(STARTED)).toBeVisible();
  const panel = (await session.openPanel('tasks')).locator('[data-slot="tasks-panel"]');
  const row = panel.locator('[data-slot="task-row"]');
  await expect(row).toHaveAttribute('data-state', 'running');

  // A turn while the agent works (`fake:slow`, ≈ 20 s): Stop in the composer ends this turn …
  await session.send('fake:slow');
  await expect(session.assistantText(/Line 2 of a slow answer/)).toBeVisible();
  await session.composerRoot.locator('[data-action="stop"]').click();
  await expect(session.transcript.locator('[data-item-kind="turn_result"]').last()).toContainText(
    'Interrupted',
  );
  // … the background agent keeps running.
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(session.panelButton('tasks').locator('[data-slot="header-panel-count"]')).toHaveText('1');
  // Ending the agent leaves nothing running behind.
  await row.locator('[data-slot="task-stop"]').click();
  await expect(row).toHaveAttribute('data-state', 'finished');
  await session.expectStatus('idle');
});

test('to-dos (fake:todo): the strip above the composer; "Tasks" opens the panel with the list', async ({
  app,
  server,
}) => {
  const session = await app.newSession(await server.makeProject('todo'));
  await session.send('fake:todo');
  await expect(session.assistantText('The first item is done; two are left.')).toBeVisible();

  const strip = session.pane.locator('[data-slot="task-strip"]');
  await expect(strip.locator('[data-slot="task-strip-line"]')).toHaveText('1 of 3 done');
  // The strip sits above the composer.
  const stripBox = await strip.boundingBox();
  const composerBox = await session.composer.boundingBox();
  expect(stripBox !== null && composerBox !== null && stripBox.y < composerBox.y).toBe(true);
  await strip.getByRole('button', { name: /1 of 3 done/ }).click();
  await expect(strip).toHaveAttribute('data-state', 'expanded');
  const items = strip.locator('[data-slot="todo-items"] li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-status', 'completed');
  await expect(items.nth(1)).toHaveAttribute('data-status', 'pending');

  await strip.locator('[data-slot="task-strip-open"]').click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'tasks');
  await expect(session.sidePanel.locator('[data-slot="tasks-todos"]')).toContainText('Run the tests');
  await expect(session.panelButton('tasks').locator('[data-slot="header-panel-count"]')).toHaveText('2');
});
