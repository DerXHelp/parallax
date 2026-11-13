/**
 * WP-69 verification (FakeBackend):
 * - the Agent card's "Transcript" opens the subagent's whole transcript read-only in the side panel
 *   tab "Agent"; while the agent runs the tab grows (polled, `session.subagentTranscript`), after its
 *   end it shows the answer and "Finished";
 * - hook runs (`fake:hooks`) per Settings → General → "Hook runs": failed and blocking only (default)
 *   as an error notice "Hook PreToolUse blocked Write" with its output, "All" also the successful runs
 *   as steps "× Hook", "Off" no hook rows at all.
 * Own server; 1600 px wide (the side panel next to the transcript).
 */
import type { Locator } from '@playwright/test';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'wp69', viewport: { width: 1600, height: 900 } });

/** `fake:subagent`: prompt + three steps (thinking, tool call) + thinking + answer. */
const FINAL_ENTRIES = 9;

async function chooseRadio(scope: Locator, name: string): Promise<void> {
  const radio = scope.getByRole('radio', { name, exact: true });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

test('Agent card → "Transcript": the tab grows while the agent runs and ends with its answer', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('subagent'));
  await session.send('fake:subagent');
  await expect(session.assistantText('The subagent is still running')).toBeVisible();

  const open = session.transcript.locator('[data-slot="agent-open-transcript"]');
  await expect(open).toHaveCount(1);
  await open.click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'subagent');
  await expect(session.panelTab('subagent')).toContainText('Fake ping');

  const panel = session.sidePanel.locator('[data-slot="subagent-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-item-kind="user_message"]')).toContainText('Reply with exactly the word PONG.');
  // While it runs the tab shows only part of the transcript (status and count from the same page).
  let partial = '';
  await expect
    .poll(async () => {
      const snapshot = await panel.evaluate((element) => ({
        running: element.getAttribute('data-running'),
        count: element.querySelector('[data-slot="subagent-count"]')?.textContent ?? '',
      }));
      if (snapshot.running === 'true') partial = snapshot.count;
      return snapshot.running;
    })
    .toBe('true');
  expect(Number.parseInt(partial, 10)).toBeLessThan(FINAL_ENTRIES);

  // … it grows by the agent's steps and ends with its answer.
  await expect(panel).toHaveAttribute('data-running', 'false', { timeout: 20_000 });
  await expect(panel.locator('[data-slot="subagent-count"]')).toHaveText(`${String(FINAL_ENTRIES)} entries`);
  await expect(panel.locator('[data-item-kind="assistant_text"]')).toContainText('PONG');
  await expect(panel.locator('[data-slot="subagent-status"]')).toContainText('Finished');
  // Compact view: the agent's steps as group lines (the read-only rows are covered by the unit tests).
  await expect(panel.locator('[data-slot="step-group"]').first()).toBeVisible();
  await expect(session.assistantText('SUBAGENT SAID PONG')).toBeVisible();
});

test('hook runs per setting: failed only (default), all, off', async ({ app, page, server }) => {
  const session = await app.newSession(await server.makeProject('hooks'));
  await session.send('fake:hooks');
  await expect(session.assistantText('writing hello.txt was blocked by a hook')).toBeVisible();
  await session.expectStatus('idle');

  // Default "failed": only the blocking run, as an error with its output to open.
  const failed = session.transcript.locator('[data-slot="hook-failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText('Hook PreToolUse blocked Write');
  await failed.getByRole('button', { name: 'Output' }).click();
  await expect(failed).toContainText('Writing is blocked in this project');
  await expect(session.transcript.locator('[data-slot="hook"]')).toHaveCount(0);
  await expect(session.stepGroups().filter({ hasText: 'Hook' })).toHaveCount(0);

  // "All": the successful runs as steps "× Hook" (rows of their own once a group is open).
  let settings = await app.openSettingsPage('general');
  await chooseRadio(settings.locator('[data-setting="hookDisplay"]'), 'All');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(session.stepGroups().filter({ hasText: '× Hook' }).first()).toBeVisible();
  await session.expandSteps();
  await expect(session.transcript.locator('[data-slot="hook"]')).toHaveCount(4);
  await expect(failed).toHaveCount(1);

  // "Off": no hook rows (a failed SessionStart/Setup hook would stay – not part of this scenario).
  settings = await app.openSettingsPage('general');
  await chooseRadio(settings.locator('[data-setting="hookDisplay"]'), 'Off');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(session.transcript.locator('[data-slot="hook"], [data-slot="hook-failed"]')).toHaveCount(0);
  await expect(session.stepGroups().filter({ hasText: 'Hook' })).toHaveCount(0);
  await expect(session.assistantText('writing hello.txt was blocked by a hook')).toBeVisible();
});
