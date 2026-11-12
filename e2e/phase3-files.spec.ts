/**
 * Phase-3 verification "files" (WP-60 E2E 1–4 and 8; WP-53/54/55/58 over the file service):
 * 1. viewer – `fake:files` links in the answer and in the tool cards; Markdown rendered and as
 *    source, code opened at `:12` with the line marked, image, PDF in Chrome's viewer (response CSP
 *    `FILE_PDF_CSP`, `X-Frame-Options: SAMEORIGIN`, no download – L10), truncated text, a change on
 *    disk shows within 3 s;
 * 2. guard of `GET /api/file` (L16) – the page's requests carry `Sec-Fetch-Site: same-origin`; a page
 *    of another origin (the server log names the refusal) and a direct call without the header are
 *    refused;
 * 3. a network path (L15) – no link, no command, no `/api/file` request, nothing in the server log;
 * 4. "Files of this session" – read, written, edited, plan and task output; a row opens the viewer;
 * 8. editor/Explorer – a custom editor saved in the settings "Files"; "Open in editor" and "Open
 *    folder in Explorer" reach the server's opener, which with the FakeBackend only logs
 *    `file.open (fake): <target> <path>` (no program starts).
 * FIX-R5-F6: V4-01 – in a project folder with spaces and umlauts, absolute paths in running text,
 * in backticks and as a Markdown link are links and open the viewer; no prefix piece is marked. The
 * 3-s bound of the live change is measured in the page (R5W-11).
 * The file runs on a server of its own (temp home, projects); 1600 px wide, so the side panel lies
 * next to the transcript instead of over it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { Page, Request } from '@playwright/test';
import { API_PATHS, FILE_PDF_CSP, fileUrl } from '@shared/http';
import { rawRequest } from '../src/server/http/testServer';
import {
  README_TITLE,
  logMessages,
  recordTextShown,
  rejectedRequests,
  textShownAt,
  writeSampleFiles,
} from './support/files';
import { expect, test } from './support/fixtures';
import { serverSettings } from './support/server';

test.use({ ownServer: 'p3files', viewport: { width: 1600, height: 900 } });

/** Requests of the page to GET/HEAD /api/file. */
function fileRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === API_PATHS.file) requests.push(request);
  });
  return requests;
}

const FILES_ANSWER = 'I read, wrote and changed files';

test('viewer: links in text and tool cards; Markdown, code at :12, image, PDF (L10), truncated text, live change', async ({
  app,
  server,
  page,
}) => {
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const project = await server.makeProject('viewer');
  const files = await writeSampleFiles(project);
  const session = await app.newSession(project);
  await session.send('fake:files');
  const answer = session.assistantText(FILES_ANSWER);
  await expect(answer).toBeVisible();
  await session.expectStatus('idle');
  // The compact view (WP-63) shows the work steps as one line: open them.
  await session.expandSteps();

  // Tool cards link the file they touched; the Read card opens the notes as rendered Markdown.
  for (const tool of ['Read', 'Write', 'Edit']) {
    await expect(session.toolCall(tool).locator('[data-slot="tool-file"] [data-state="link"]')).toHaveCount(
      1,
    );
  }
  let viewer = await session.openFile(
    session.toolCall('Read').locator('[data-slot="tool-file"] [data-state="link"]'),
    'notes.md',
    'markdown',
  );
  await expect(viewer.locator('[data-slot="markdown-view"] h1')).toHaveText('Fake notes');

  // `<path>:12` in the answer: the code opens at line 12, marked.
  viewer = await session.openFile(session.fileLink(answer, 'app.ts:12'), 'app.ts', 'text');
  const line12 = viewer.locator('[data-slot="code-view"] [data-line="12"]');
  await expect(line12).toHaveAttribute('aria-current', 'true');
  await expect(line12).toContainText('const answer = 42;');
  await expect(line12).toBeInViewport();

  // Absolute paths in an answer (the fake echoes them): Markdown, image, PDF, truncated text, notes.
  await session.send(`look at ${files.readme} ${files.image} ${files.pdf} ${files.big} ${files.notes}`);
  const echo = session.assistantText('Echo: look at');
  await expect(echo).toBeVisible();

  // README.md: rendered, then as source.
  viewer = await session.openFile(session.fileLink(echo, 'README.md'), 'README.md', 'markdown');
  await expect(viewer.locator('[data-slot="markdown-view"] h1')).toHaveText(README_TITLE);
  await viewer.getByRole('radio', { name: 'Source' }).click();
  await expect(viewer.locator('[data-slot="code-view"]')).toContainText(`# ${README_TITLE}`);
  await expect(viewer.locator('[data-slot="markdown-view"]')).toHaveCount(0);

  viewer = await session.openFile(session.fileLink(echo, 'shot.png'), 'shot.png', 'image');
  const image = viewer.locator('[data-slot="image-view"] img');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img) => (img instanceof HTMLImageElement ? img.naturalWidth : 0)))
    .toBeGreaterThan(0);

  const pdfResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === API_PATHS.file &&
      response.url().includes('doc.pdf') &&
      response.request().resourceType() === 'document',
  );
  viewer = await session.openFile(session.fileLink(echo, 'doc.pdf'), 'doc.pdf', 'pdf');
  await expect(viewer.locator('[data-slot="pdf-view"] iframe')).toBeVisible();
  const pdf = await pdfResponse;
  expect(pdf.status()).toBe(200);
  const headers = await pdf.allHeaders();
  expect(headers['content-type']).toBe('application/pdf');
  expect(headers['content-security-policy']).toBe(FILE_PDF_CSP);
  expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(headers['content-disposition'] ?? '').not.toMatch(/attachment/i);

  viewer = await session.openFile(session.fileLink(echo, 'big.log'), 'big.log', 'text');
  await expect(viewer.locator('[data-slot="file-truncated"]')).toBeVisible();
  await expect(viewer.locator('[data-slot="code-view"] [data-line="1"]')).toContainText('xxxx');

  // A change on disk shows by itself (stat every 2 s while visible) – within 3 s. The page notes the
  // moment the new text shows, so the bound applies to the app and not to the retry interval of
  // the assertion (up to 1 s; with a 2-s poll that left too little room under load, R5W-11).
  viewer = await session.openFile(session.fileLink(echo, 'notes.txt'), 'notes.txt', 'text');
  await expect(viewer.locator('[data-slot="code-view"]')).toContainText('first version of the notes');
  const second = 'second version of the notes';
  await recordTextShown(page, `[data-side-panel="${session.key}"] [data-slot="code-view"]`, second);
  const written = Date.now();
  await writeFile(files.notes, `${second}\n`);
  await expect(viewer.locator('[data-slot="code-view"]')).toContainText(second);
  const shownAt = await textShownAt(page);
  expect(shownAt, 'the page noted the new text').not.toBeNull();
  const latency = (shownAt ?? Number.POSITIVE_INFINITY) - written;
  test.info().annotations.push({ type: 'live change (ms)', description: String(latency) });
  expect(latency, 'disk change → viewer (ms)').toBeLessThanOrEqual(3_000);
  expect(downloads).toEqual([]);
});

test('paths with spaces and umlauts (V4-01): absolute paths in text, in backticks and as a Markdown link are links and open the viewer; no prefix is marked', async ({
  app,
  server,
}) => {
  const project = await server.makeProject('Projekt mit Leerzeichen äöü');
  await mkdir(join(project, 'Unter Ordner'));
  const readme = join(project, 'README.md');
  const notes = join(project, 'Meine Notizen.txt');
  const plan = join(project, 'Unter Ordner', 'Plan für später.md');
  await writeFile(readme, `# ${README_TITLE}\n`);
  await writeFile(notes, 'notes with a space in the name\n');
  await writeFile(plan, '# Plan für später\n');
  const session = await app.newSession(project);

  // Running text (folder names with spaces – the path goes on to the file with its extension), an
  // inline code span (as a whole – also a file name with spaces) and a Markdown link.
  await session.send(`see ${readme} and \`${notes}\` and [the plan](<${plan.replaceAll('\\', '/')}>) please`);
  const echo = session.assistantText('Echo: see');
  await expect(echo).toBeVisible();
  const links = echo.locator('[data-slot="file-link"][data-state="link"]');
  await expect(links).toHaveCount(3);
  // Nothing else is a reference: no refused, missing or unchecked prefix ("…\02-Projekt") is left.
  await expect(echo.locator('[data-slot="file-link"]')).toHaveCount(3);
  await expect(links.nth(0)).toHaveText(readme);
  await expect(links.nth(1)).toHaveText(notes);
  await expect(links.nth(2)).toHaveText('the plan');

  let viewer = await session.openFile(links.nth(0), 'README.md', 'markdown');
  await expect(viewer.locator('[data-slot="markdown-view"] h1')).toHaveText(README_TITLE);
  viewer = await session.openFile(links.nth(1), 'Meine Notizen.txt', 'text');
  await expect(viewer.locator('[data-slot="code-view"]')).toContainText('notes with a space in the name');
  viewer = await session.openFile(links.nth(2), 'Plan für später.md', 'markdown');
  await expect(viewer.locator('[data-slot="markdown-view"] h1')).toHaveText('Plan für später');
});

test('guard of /api/file (L16): the page sends Sec-Fetch-Site same-origin; another origin and a direct call are refused', async ({
  app,
  server,
  page,
  context,
}) => {
  const requests = fileRequests(page);
  const project = await server.makeProject('guard');
  const files = await writeSampleFiles(project);
  const session = await app.newSession(project);
  await session.send(`see ${files.image} ${files.readme}`);
  const echo = session.assistantText('Echo: see');
  await expect(echo).toBeVisible();
  await session.openFile(session.fileLink(echo, 'shot.png'), 'shot.png', 'image');
  await expect(session.filePanel.locator('[data-slot="image-view"] img')).toBeVisible();
  const viewer = await session.openFile(session.fileLink(echo, 'README.md'), 'README.md', 'markdown');
  await expect(viewer.locator('[data-slot="markdown-view"] h1')).toHaveText(README_TITLE);
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const request of requests) expect(await request.headerValue('sec-fetch-site')).toBe('same-origin');

  // A page of another origin (a real page on another loopback port – an intercepted page would
  // not count as loopback, and Chrome's Local Network Access would block the fetch before it is
  // sent): the browser sends its Origin and `Sec-Fetch-Site: same-site` – the guard refuses (403
  // ORIGIN_REJECTED, logged as "request rejected"); the page only sees a failed fetch (no CORS answer).
  const foreign = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Other origin</title>');
  });
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  try {
    const address = foreign.address();
    if (address === null || typeof address === 'string') throw new Error('no port for the foreign page');
    const foreignOrigin = `http://127.0.0.1:${String(address.port)}`;
    const other = await context.newPage();
    await other.goto(`${foreignOrigin}/`);
    const target = `${server.origin}${fileUrl(session.entryId, files.readme)}`;
    const fetched = await other.evaluate(async (url) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        return `answer ${String(response.status)}`;
      } catch {
        return 'failed';
      }
    }, target);
    expect(fetched).toBe('failed');
    await expect
      .poll(() => rejectedRequests(server))
      .toContain(`file ${foreignOrigin} same-site ORIGIN_REJECTED/origin`);
    await other.close();
  } finally {
    foreign.closeAllConnections();
    await new Promise<void>((resolve) => {
      foreign.close(() => {
        resolve();
      });
    });
  }

  // A direct call with the device cookie but without Sec-Fetch-Site: refused; with it: served.
  const cookie = await server.deviceCookie();
  const path = fileUrl(session.entryId, files.readme);
  expect((await rawRequest(server.port, { method: 'GET', path, headers: { cookie } })).status).toBe(403);
  const served = await rawRequest(server.port, {
    method: 'GET',
    path,
    headers: { cookie, 'sec-fetch-site': 'same-origin' },
  });
  expect(served.status).toBe(200);
  expect(served.body).toContain(README_TITLE);
});

test('a network path (L15) stays text: no link, no command, no /api/file request, nothing in the server log', async ({
  app,
  server,
  page,
}) => {
  const requests = fileRequests(page);
  const sent: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => {
      sent.push(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8'));
    });
  });
  // The recorder must see the socket from its start.
  await page.reload();
  await app.waitConnected();

  const project = await server.makeProject('unc');
  await writeSampleFiles(project);
  const session = await app.newSession(project);
  await session.send('fake:files');
  const answer = session.assistantText(FILES_ANSWER);
  await expect(answer).toContainText('\\\\fake-host\\share\\x.txt');
  // The other references of the answer are checked and linked meanwhile …
  await expect(session.fileLink(answer, 'app.ts:12')).toBeVisible();
  await expect(session.fileLink(answer, 'notes.md')).toBeVisible();
  // … the network path is plain text without a link.
  await expect(answer.locator('[data-file-ref="unsafe"]')).toContainText('fake-host');
  await expect(answer.locator('[data-slot="file-link"]').filter({ hasText: 'fake-host' })).toHaveCount(0);

  expect(requests.map((request) => request.url()).filter((url) => url.includes('fake-host'))).toEqual([]);
  expect(sent.filter((frame) => frame.includes('fake-host'))).toEqual([]);
  expect((await server.logLines()).filter((line) => line.includes('fake-host'))).toEqual([]);
});

test('"Files of this session": read, written, edited, plan and task output; a row opens the viewer', async ({
  app,
  server,
}) => {
  const project = await server.makeProject('session-files');
  const session = await app.newSession(project);
  await session.send('fake:files');
  await expect(session.assistantText(FILES_ANSWER)).toBeVisible();
  await session.expectStatus('idle');

  await session.send('fake:plan make hello.txt');
  const card = await session.armedCard('plan');
  await card.locator('[data-action="approve"]').click();
  await expect(session.assistantText('IMPLEMENTED')).toBeVisible();
  await session.expectStatus('idle');

  // A background agent: its output file is listed while it still runs.
  await session.send('fake:background');
  await expect(session.assistantText('A background agent is working on it')).toBeVisible();

  const panel = (await session.openPanel('files')).locator('[data-slot="files-panel"]');
  const row = (suffix: string) => panel.locator(`[data-slot="files-row"][data-path$="${suffix}"]`);
  await expect(row('notes.md').locator('[data-op="read"]')).toBeVisible();
  await expect(row('new-file.txt').locator('[data-op="written"]')).toBeVisible();
  await expect(row('app.ts').locator('[data-op="edited"]')).toBeVisible();
  await expect(row('fake-plan.md').locator('[data-op="plan"]')).toBeVisible();
  await expect(row('.output').locator('[data-op="output"]')).toBeVisible();
  // The fake's files are real files below the temp home (`<home>\fake-files`), not in the project.
  for (const suffix of ['notes.md', 'new-file.txt', 'app.ts', 'fake-plan.md', '.output']) {
    const path = (await row(suffix).getAttribute('data-path')) ?? '';
    expect(path.toLowerCase().startsWith(server.home.toLowerCase())).toBe(true);
  }

  await row('app.ts').locator('button').first().click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'file');
  await expect(session.filePanel.locator('[data-slot="file-panel-title"]')).toContainText('app.ts');
  await expect(session.filePanel.locator('[data-slot="code-view"]')).toContainText('const answer = 42;');
});

test('editor and Explorer: a custom editor from the settings; "Open in editor" / "Open folder in Explorer" only log with the FakeBackend', async ({
  app,
  server,
  page,
}) => {
  const editor = 'C:\\Tools\\FakeEditor\\editor.exe';
  const settings = await app.openSettingsPage('files');
  await settings.locator('[data-preset="custom"] [role="radio"]').click();
  const form = settings.locator('[data-slot="editor-form"]');
  await form.locator('input').fill(editor);
  await form.locator('textarea').fill('-n{line}\n{file}');
  await expect(settings.locator('[data-slot="editor-preview"]')).toContainText('editor.exe');
  await form.locator('[data-action="editor-save"]').click();
  await expect(form.locator('[data-slot="editor-unsaved"]')).toHaveCount(0);
  await expect
    .poll(async () => (await serverSettings(server)).editor)
    .toEqual({ preset: 'custom', executable: editor, args: ['-n{line}', '{file}'] });
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();

  const project = await server.makeProject('editor');
  const files = await writeSampleFiles(project);
  const session = await app.newSession(project);
  await session.send(`open ${files.readme}`);
  const echo = session.assistantText('Echo: open');
  const viewer = await session.openFile(session.fileLink(echo, 'README.md'), 'README.md', 'markdown');
  await viewer.locator('[data-slot="file-panel-header"] [data-action="editor"]').click();
  await expect.poll(() => logMessages(server)).toContain(`file.open (fake): editor ${files.readme}`);
  await viewer.locator('[data-slot="file-panel-header"] [data-action="explorer"]').click();
  await expect.poll(() => logMessages(server)).toContain(`file.open (fake): explorer ${files.readme}`);

  // The session menu: "Open folder in Explorer" (the cwd).
  await session.headerAction('openFolder');
  await expect.poll(() => logMessages(server)).toContain(`file.open (fake): explorer ${project}`);
});
