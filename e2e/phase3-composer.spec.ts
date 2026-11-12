/**
 * Phase-3 verification "composer" (WP-60 E2E 7; WP-51/53/57/58): a PDF through the paperclip and an
 * .xlsx dropped over the transcript become chips, are uploaded and sent – the fake answers
 * "received 1 document(s), 1 file(s)" and the file lies in the attachment folder of the temp home;
 * a big paste becomes a chip and goes out as `inline_pastes` ("received 1 paste(s)"); the @ picker
 * lists the project files – from git (ignored files left out) and by walking a folder without
 * git – and inserts `@path`.
 * Own server.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Locator } from '@playwright/test';
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
