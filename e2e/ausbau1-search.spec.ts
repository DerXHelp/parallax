/**
 * WP-117 (Ausbau 1): the full-text search (WP-115 on the search worker of WP-112) with the FakeBackend:
 * a turn with a unique word in one session (prompt and echoed answer on disk, the fake title and turn
 * summary repeat it), another session open; Ctrl+Shift+F opens the search, the word finds title,
 * summary, answer and prompt of that session in one group (answer before prompt – newest first); the
 * arrow keys choose the answer, Enter opens the session, focuses its message field and marks the hit
 * in the transcript for a moment (`data-revealed`, noted by a page recorder – the mark lasts only
 * 2 s). Escape closes the dialog without a choice and gives the focus back. Own server (worker).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';

test.use({ ownServer: 'a1search' });

const WORD = 'quokka-lantern-7319';

/** Notes the text of every transcript row that gets `data-revealed` (attribute changes included). */
async function recordRevealed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: string[] = [];
    window.__e2eRevealed = seen;
    const note = () => {
      for (const row of document.querySelectorAll('[data-revealed]')) {
        const text = row.textContent.trim();
        if (!seen.includes(text)) seen.push(text);
      }
    };
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-revealed'],
    });
    note();
  });
}

function revealedRows(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__e2eRevealed ?? []);
}

test('Ctrl+Shift+F finds a turn of another session; Enter opens it and marks the hit; Escape closes', async ({
  app,
  server,
  page,
}) => {
  const target = await app.newSession(await server.makeProject('search-target'));
  await target.send(`please remember ${WORD}`);
  await expect(target.assistantText(`Echo: please remember ${WORD}`)).toBeVisible();
  await target.expectStatus('idle');
  // The automatic title (FakeBackend: "Fake: <first words>") repeats the word – a hit of its own.
  await expect(app.row(target.key).locator('[data-slot="row-title"]')).toContainText(WORD);
  const other = await app.newSession(await server.makeProject('search-other'));
  await other.send('nothing to find here');
  await expect(other.assistantText('Echo: nothing to find here')).toBeVisible();

  // Escape: closed without a choice, the focus goes back to the message field.
  await other.composer.focus();
  await page.keyboard.press('Control+Shift+F');
  const dialog = page.locator('[data-slot="search-dialog"]');
  const input = dialog.locator('[data-slot="search-input"]');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(other.composer).toBeFocused();

  // Search: title, turn summary, answer and prompt of the target session – one group, newest first.
  await page.keyboard.press('Control+Shift+F');
  await expect(input).toBeFocused();
  await input.fill(WORD);
  const options = dialog.locator('[role="option"]');
  await expect(dialog.locator('[data-slot="search-status"]')).toHaveText('4 hits');
  await expect(options).toHaveCount(4);
  await expect(dialog.locator('[data-slot="search-results"] > [role="group"]')).toHaveCount(1);
  await expect(dialog.locator(`[role="group"][data-session="${target.key}"]`)).toHaveCount(1);
  const kinds = await options.evaluateAll((all) => all.map((option) => option.getAttribute('data-kind')));
  expect([...kinds].sort()).toEqual(['answer', 'prompt', 'summary', 'title']);
  expect(kinds.indexOf('answer')).toBeLessThan(kinds.indexOf('prompt'));
  const answer = dialog.locator('[role="option"][data-kind="answer"]');
  await expect(answer.locator('[data-slot="search-snippet"] mark')).toHaveText(WORD);
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  // Arrow keys move the choice to the answer (a title hit would only open the session).
  for (let index = 0; index < kinds.indexOf('answer'); index++) await page.keyboard.press('ArrowDown');
  await expect(answer).toHaveAttribute('aria-selected', 'true');

  // Enter: the target session opens, its message field has the focus, the hit is marked.
  await recordRevealed(page);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await app.waitForSelection((key) => key === target.key);
  await expect(target.pane).toBeVisible();
  await expect(target.composer).toBeFocused();
  await expect
    .poll(() => revealedRows(page))
    .toContainEqual(expect.stringContaining(`Echo: please remember ${WORD}`));
});
