/**
 * Phase-3 verification "composer" (WP-60 E2E 7; WP-51/53/57/58): a PDF through the paperclip and an
 * .xlsx dropped over the transcript become chips, are uploaded and sent – the fake answers
 * "received 1 document(s), 1 file(s)" and the file lies in the attachment folder of the temp home;
 * a big paste becomes a chip and goes out as `inline_pastes` ("received 1 paste(s)"); the @ picker
 * lists the project files – from git (ignored files left out) and by walking a folder without
 * git – and inserts `@path`.
 * FIX-R5-F6: R5W-03 – a paste starting with "/" at the start of the field goes out as a prompt
 * (U+200B in front, invisible in the bubble, not in the title); V4-03 – typing after ↓ marks the
 * best match of the @ picker again, no scattered hit, Tab inserts it.
 * Own server.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { z } from 'zod';
import { runFile } from '../src/server/lib/process';
import { resolveExecutable } from '../src/server/lib/windows';
import { expect, test } from './support/fixtures';
import type { SessionView } from './support/app';

test.use({ ownServer: 'p3composer' });

const PDF_TEXT = '%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n';

/** Drops one file (name, MIME type, text content) on `target` as Chrome fires a drop from the Explorer. */
async function dropFile(target: Locator, file: { name: string; type: string; text: string }): Promise<void> {
  await target.evaluate((element, dropped) => {
    const data = new DataTransfer();
    data.items.add(new File([dropped.text], dropped.name, { type: dropped.type }));
    for (const type of ['dragenter', 'dragover', 'drop']) {
      element.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  }, file);
}

/** Pastes `text` into the composer (a clipboard event as Chrome fires it for Ctrl+V). */
async function pasteText(session: SessionView, text: string): Promise<void> {
  await session.composer.evaluate((field, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    field.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

/** All file names below `dir` (recursive). */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

test('attachments: PDF through the paperclip, .xlsx dropped over the transcript → sent, stored in the home', async ({
  app,
  server,
  page,
}) => {
  const project = await server.makeProject('attachments');
  const pdf = path.join(project, 'report.pdf');
  await writeFile(pdf, PDF_TEXT);
  const session = await app.newSession(project);
  const chips = session.composerRoot.locator('[data-slot="attachment-chip"]');

  const chooser = page.waitForEvent('filechooser');
  await session.composerRoot.locator('[data-action="attach"]').click();
  await (await chooser).setFiles(pdf);
  await dropFile(session.transcript, {
    name: 'data.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    text: 'PK\u0003\u0004 fake spreadsheet',
  });
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) await expect(chip).toHaveAttribute('data-status', 'done');
  await expect(chips.filter({ hasText: 'report.pdf' })).toHaveCount(1);
  await expect(chips.filter({ hasText: 'data.xlsx' })).toHaveCount(1);

  await session.composer.fill('please read both');
  await session.composer.press('Enter');
  await expect(chips).toHaveCount(0);
  await expect(session.assistantText('Fake: received 1 document(s), 1 file(s)')).toBeVisible();
  // The non-image file is materialized for Claude in the entry's attachment folder of the home.
  const folder = path.join(server.home, 'entries', session.entryId, 'attachments');
  await expect.poll(() => filesBelow(folder)).toContain('data.xlsx');
});

/**
 * U+200B ZERO WIDTH SPACE – the composer's `SLASH_GUARD` in front of a prompt that starts with "/"
 * only because of a pasted text (R5W-03). Built from its code so the source shows no invisible
 * character.
 */
const SLASH_GUARD = String.fromCharCode(0x200b);

const sentPromptSchema = z.object({
  type: z.literal('cmd'),
  cmd: z.object({
    name: z.literal('session.sendPrompt'),
    prompt: z.object({ text: z.string(), pastes: z.array(z.string()).optional() }),
  }),
});

/** Records the prompts the page sends (`session.sendPrompt` frames); reload the page after it. */
function recordSentPrompts(page: Page): { text: string; pastes: string[] }[] {
  const prompts: { text: string; pastes: string[] }[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      const sent = sentPromptSchema.safeParse(parsed);
      if (!sent.success) return;
      prompts.push({ text: sent.data.cmd.prompt.text, pastes: sent.data.cmd.prompt.pastes ?? [] });
    });
  });
  return prompts;
}

test('a pasted text starting with "/" at the start of the field goes as a prompt, not as a command (R5W-03)', async ({
  app,
  server,
  page,
}) => {
  const prompts = recordSentPrompts(page);
  // The recorder must see the socket from its start.
  await page.reload();
  await app.waitConnected();
  const session = await app.newSession(await server.makeProject('paste-slash'));
  const lines = ['/clear --all', ...Array.from({ length: 39 }, (_, i) => `log line ${String(i + 2)}`)];
  const pasted = lines.join('\n');
  await session.composer.click();
  await pasteText(session, pasted);
  await expect(session.composerRoot.locator('[data-slot="paste-chip"]')).toHaveCount(1);
  // The field starts with the token, not with "/": no slash menu.
  await expect(session.composer).toHaveValue(/^\[#1/);
  await session.composer.press('End');
  await session.composer.pressSequentially(' what failed?');
  await session.composer.press('Enter');

  // An answer of the model (the paste receipt), no command.
  await expect(session.assistantText('Fake: received 1 paste(s)')).toBeVisible();
  await expect.poll(() => prompts.length).toBe(1);
  const [prompt] = prompts;
  // The guard in front: the text never starts with "/", not even trimmed; the question goes on a
  // line of its own (V4-07); the paste occurs verbatim (`prompt.pastes`).
  expect(prompt?.text).toBe(`${SLASH_GUARD}${pasted}\nwhat failed?`);
  expect(prompt?.text.trim().startsWith('/')).toBe(false);
  expect(prompt?.pastes).toEqual([pasted]);

  // The user bubble shows the text without a visible character in front of "/clear": the guard
  // stands in the bubble's text and takes no width.
  const bubble = session.userMessages().last();
  await expect(bubble).toContainText('/clear --all');
  const guardWidth = await bubble.evaluate((element, guard) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(`${guard}/clear`) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range.getBoundingClientRect().width;
    }
    return null;
  }, SLASH_GUARD);
  expect(guardWidth, 'width of the guard character in the bubble').toBe(0);

  // The session title comes from the prompt – without the guard (coordinator rework e38a344).
  const title = app.row(session.key).locator('[data-slot="row-title"]');
  await expect(title).toHaveText('/clear --all');
  expect(await title.textContent()).not.toContain(SLASH_GUARD);
  await expect(session.header.locator('h1')).toHaveText('/clear --all');
});

test('a big paste becomes a chip and goes out as inline_pastes', async ({ app, server }) => {
  const session = await app.newSession(await server.makeProject('paste'));
  const big = Array.from({ length: 40 }, (_, i) => `log line ${String(i + 1)}: ${'-'.repeat(60)}`).join('\n');
  await session.composer.click();
  await pasteText(session, big);
  const chip = session.composerRoot.locator('[data-slot="paste-chip"]');
  await expect(chip).toHaveCount(1);
  // The field holds a token (`[#1 · 40 lines]`), the chip the text.
  await expect(session.composer).toHaveValue(/#1/);
  await expect(session.composer).not.toHaveValue(/log line 40/);
  await session.composer.press('End');
  await session.composer.pressSequentially(' what failed?');
  await session.composer.press('Enter');
  await expect(chip).toHaveCount(0);
  await expect(session.assistantText('Fake: received 1 paste(s)')).toBeVisible();
});

/** Types `@query` and picks `relative` from the @ picker; the draft then holds `@relative `. */
async function mention(session: SessionView, query: string, relative: string): Promise<Locator> {
  await session.composer.click();
  await session.composer.fill('');
  await session.composer.pressSequentially(`look at @${query}`);
  const menu = session.composerRoot.locator('[data-slot="mention-menu"]');
  await expect(menu).toHaveAttribute('data-state', 'ready');
  const option = menu.getByRole('option').filter({ has: session.page.locator(`[data-path="${relative}"]`) });
  await option.click();
  await expect(session.composer).toHaveValue(`look at @${relative} `);
  await expect(menu).toHaveCount(0);
  return menu;
}

test('@ picker: project files from git (ignored ones left out) and from a folder without git', async ({
  app,
  server,
}) => {
  // Without git: the folder is walked.
  const plain = await server.makeProject('mention-plain');
  await mkdir(path.join(plain, 'docs'));
  await writeFile(path.join(plain, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(path.join(plain, 'notes.log'), 'walked too\n');
  const first = await app.newSession(plain);
  const menu = await mention(first, 'guid', 'docs/guide.md');
  await first.composer.pressSequentially('@notes');
  await expect(menu.locator('[data-path="notes.log"]')).toBeVisible();
  await first.composer.press('Escape');

  // With git (absolute git.exe from PATH, like the server): `git ls-files` honours .gitignore.
  const git = await resolveExecutable('git', process.env);
  test.skip(git === null, 'no git on the PATH of this machine');
  if (git === null) return;
  const repo = await server.makeProject('mention-git');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  const init = await runFile(git, ['init'], { cwd: repo, env, timeoutMs: 30_000 });
  expect(init.exitCode, init.stderr).toBe(0);
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src', 'main.ts'), 'export {};\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored.log\n');
  await writeFile(path.join(repo, 'ignored.log'), 'not listed\n');
  const second = await app.newSession(repo);
  const gitMenu = await mention(second, 'main', 'src/main.ts');
  await second.composer.pressSequentially('@ignored');
  await expect(gitMenu).toHaveAttribute('data-state', 'ready');
  await expect(gitMenu.locator('[data-path="ignored.log"]')).toHaveCount(0);
  await second.composer.press('Escape');
});

/** The option of the @ picker that the field marks as active (`aria-activedescendant`). */
async function activeOption(session: SessionView, menu: Locator): Promise<Locator> {
  const id = await session.composer.getAttribute('aria-activedescendant');
  expect(id, 'aria-activedescendant of the field').not.toBeNull();
  return menu.locator(`[role="option"][id="${id ?? ''}"]`);
}

test('@ picker (V4-03): typing after ↓ marks the best match again, no scattered hit; Tab inserts it', async ({
  app,
  server,
}) => {
  const project = await server.makeProject('mention-rank');
  const deep = path.join(project, 'verschachtelt', 'noch-tiefer', 'und-noch-eine');
  await mkdir(path.join(project, 'docs'));
  await mkdir(deep, { recursive: true });
  for (const name of ['a-guide.md', 'b-notes.md', 'c-review.md']) {
    await writeFile(path.join(project, 'docs', name), `# ${name}\n`);
  }
  await writeFile(
    path.join(deep, 'mit-einem-sehr-langen-dateinamen-fuer-ueberlauf-tests-und-mehr.md'),
    '# long\n',
  );
  await writeFile(path.join(project, 'Grüße-Übersicht.txt'), 'Grüße\n');
  const session = await app.newSession(project);
  const menu = session.composerRoot.locator('[data-slot="mention-menu"]');
  const options = menu.getByRole('option');

  // V4 repro: "@", 2× ↓, then "grü" – the list shrinks to the one real match, and it is active.
  await session.composer.click();
  await session.composer.pressSequentially('look at @');
  await expect(menu).toHaveAttribute('data-state', 'ready');
  await expect(options).toHaveCount(5);
  await session.composer.press('ArrowDown');
  await session.composer.press('ArrowDown');
  await expect(await activeOption(session, menu)).toHaveAttribute('aria-selected', 'true');
  expect(await (await activeOption(session, menu)).getAttribute('id')).toBe(
    await options.nth(2).getAttribute('id'),
  );
  await session.composer.pressSequentially('grü');
  // The scattered hit through the deep folder names (g…r…ü…) is gone (minimum quality).
  await expect(options).toHaveCount(1);
  await expect(options.first().locator('[data-path]')).toHaveAttribute('data-path', 'Grüße-Übersicht.txt');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  expect(await (await activeOption(session, menu)).getAttribute('id')).toBe(
    await options.first().getAttribute('id'),
  );
  await session.composer.press('Tab');
  await expect(session.composer).toHaveValue('look at @Grüße-Übersicht.txt ');
  await expect(menu).toHaveCount(0);

  // Several matches left: after ↓↓↓ and more typing the first (best) one is active again.
  await session.composer.pressSequentially('@');
  await expect(menu).toHaveAttribute('data-state', 'ready');
  for (let i = 0; i < 3; i += 1) await session.composer.press('ArrowDown');
  await session.composer.pressSequentially('md');
  await expect(options).toHaveCount(4);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  expect(await (await activeOption(session, menu)).getAttribute('id')).toBe(
    await options.first().getAttribute('id'),
  );
  await session.composer.press('Escape');
});
