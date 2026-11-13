/**
 * WP-71 "what runs where" against the FakeBackend (`fake:workers`: two background agents and a
 * background shell): the sidebar row pulses and counts agents and shells next to the title, its
 * tooltip lists them under "Running now", the header's "Tasks" button counts by kind; the shell ends
 * first, the agents later – then the counters and the pulse are gone. Own server.
 */
import type { Locator } from '@playwright/test';
import {
  FAKE_WORKERS_AGENTS,
  FAKE_WORKERS_DONE,
  FAKE_WORKERS_SHELL,
  FAKE_WORKERS_STARTED,
} from '../src/server/backend/fake/workers';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp71' });

function count(root: Locator, group: 'agents' | 'shells' | 'misc'): Locator {
  return root.locator(`[data-slot="running-count"][data-group="${group}"]`);
}

test('fake:workers: counters in the sidebar and the header, the pulse, "Running now"; gone after the end', async ({
  app,
  server,
  page,
}) => {
  const session = await app.newSession(await server.makeProject('workers'));
  await session.send('fake:workers');
  await expect(session.assistantText(FAKE_WORKERS_STARTED)).toBeVisible();

  const row = app.row(session.key);
  const rowTasks = row.locator('[data-slot="row-tasks"]');
  await expect(count(rowTasks, 'agents')).toHaveText('2');
  await expect(count(rowTasks, 'shells')).toHaveText('1');
  await expect(rowTasks).toContainText('Running: 2 agents and 1 shell');
  // The launch turn is over, the session still works (idle is held back while tasks run).
  await expect(app.rowStatus(session.key)).toHaveAttribute('data-status', 'working');
  await expect(app.rowStatus(session.key)).toHaveAttribute('data-pulse', 'strong');

  const tasksButton = session.panelButton('tasks');
  const pill = tasksButton.locator('[data-slot="header-panel-count"]');
  await expect(pill).toHaveAttribute('data-running', 'true');
  await expect(count(pill, 'agents')).toHaveText('2');
  await expect(count(pill, 'shells')).toHaveText('1');
  await expect(tasksButton).toHaveAccessibleName('Tasks – running: 2 agents and 1 shell');

  // The row's tooltip: "Running now" with the agents' summaries and the shell's description.
  await row.hover();
  const detail = page.locator('[data-slot="row-tasks-detail"]').first();
  await expect(detail).toContainText('Running now');
  await expect(detail).toContainText(FAKE_WORKERS_AGENTS[0].summary);
  await expect(detail).toContainText(FAKE_WORKERS_SHELL.description);
  await expect(detail.locator('[data-slot="row-task"]')).toHaveCount(3);
  await page.mouse.move(0, 0);

  // The shell ends first: the agents keep running.
  await expect(count(rowTasks, 'shells')).toHaveCount(0, { timeout: 30_000 });
  await expect(count(rowTasks, 'agents')).toHaveText('2');
  await expect(count(pill, 'shells')).toHaveCount(0);

  // After the follow-up turn nothing runs: no counters, no pulse.
  await expect(session.assistantText(FAKE_WORKERS_DONE)).toBeVisible({ timeout: 45_000 });
  await session.expectStatus('idle', 30_000);
  await expect(rowTasks).toHaveCount(0);
  await expect(app.rowStatus(session.key)).not.toHaveAttribute('data-pulse');
  await expect(pill).toHaveCount(0);
});
