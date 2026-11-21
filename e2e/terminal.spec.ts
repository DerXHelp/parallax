/**
 * WP-99 (ADR-239): the embedded terminal against the server build with the FakeBackend – its echo
 * shell (`terminal/fakePty.ts`) stands in for ConPTY. Alt+T opens the tab, input reaches the shell
 * over `/api/terminal/ws`, a reload replays the scrollback, a second terminal opens, `exit` shows the
 * exit bar, and Alt+T leads back to the message field.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

/**
 * The shells of this host (WP-109) and the prompt of the echo shell (`terminal/fakePty.ts`): Windows
 * cmd (`>`) and PowerShell (`PS `); Linux the login shell and bash (both `$ ` in the test container).
 */
const SHELLS =
  process.platform === 'win32'
    ? { prompt: '>', second: 'powershell', secondPrompt: 'PS ' }
    : { prompt: '$', second: 'bash', secondPrompt: '$' };

/** Text of the active terminal (xterm's DOM rows). */
function activeRows(pane: Locator): Locator {
  return pane.locator('[data-slot="terminal-view"][data-active="true"] .xterm-rows');
}

/** Types a line into the focused terminal. */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

test('Alt+T opens a terminal; input, replay after a reload, a second terminal, exit and back to the message field', async ({
  app,
  server,
  page,
}) => {
  const project = await server.makeProject('wp99');
  const session = await app.newSession(project);
  const panel = session.pane.locator('[data-slot="terminal-panel"]');

  // Alt+T from the message field: the tab opens with one terminal of the default shell, focused.
  await page.keyboard.press('Alt+T');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-slot="terminal-tab"]')).toHaveCount(1);
  const view = panel.locator('[data-slot="terminal-view"][data-active="true"]');
  await expect(view).toHaveAttribute('data-state', 'running');
  await expect(view.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(activeRows(session.pane)).toContainText(SHELLS.prompt);

  await typeLine(page, 'echo px-e2e-42');
  // The echoed command and its output.
  await expect
    .poll(async () => ((await activeRows(session.pane).innerText()).match(/px-e2e-42/g) ?? []).length)
    .toBe(2);

  // Alt+T inside the terminal: back to the message field; the panel stays open.
  await page.keyboard.press('Alt+T');
  await expect(session.composer).toBeFocused();
  await expect(panel).toBeVisible();

  // A reload: the shell kept running on the server, the scrollback comes back.
  await page.reload();
  await app.waitConnected();
  const again = app.session(session.key);
  await expect(again.pane).toBeVisible();
  if (!(await again.pane.locator('[data-slot="terminal-panel"]').isVisible())) {
    await again.composer.click();
    await page.keyboard.press('Alt+T');
  }
  const panelAgain = again.pane.locator('[data-slot="terminal-panel"]');
  await expect(panelAgain.locator('[data-slot="terminal-tab"]')).toHaveCount(1);
  await expect(activeRows(again.pane)).toContainText('px-e2e-42');

  // A second terminal from "+" (PowerShell, Linux bash). Under Linux both prompts are `$ `: wait for
  // the new terminal itself (another id, running, its own prompt) before typing into it.
  const active = panelAgain.locator('[data-slot="terminal-view"][data-active="true"]');
  const firstId = (await active.getAttribute('data-terminal-id')) ?? '';
  await panelAgain.locator('[data-slot="terminal-add"]').click();
  await page.getByRole('menu').locator(`[data-choice="${SHELLS.second}"]`).click();
  await expect(panelAgain.locator('[data-slot="terminal-tab"]')).toHaveCount(2);
  await expect(active).not.toHaveAttribute('data-terminal-id', firstId);
  await expect(active).toHaveAttribute('data-state', 'running');
  await expect(activeRows(again.pane)).toContainText(SHELLS.secondPrompt);
  await expect(activeRows(again.pane)).not.toContainText('px-e2e-42');

  // `exit 3` in it: the exit bar with the code.
  await active.locator('.xterm-helper-textarea').focus();
  await expect(active.locator('.xterm-helper-textarea')).toBeFocused();
  await typeLine(page, 'exit 3');
  const exitBar = panelAgain.locator('[data-slot="terminal-exit-bar"]');
  await expect(exitBar).toBeVisible();
  await expect(exitBar).toContainText('3');
  await expect(panelAgain.locator('[data-slot="terminal-view"][data-active="true"]')).toHaveAttribute(
    'data-state',
    'exited',
  );
});
