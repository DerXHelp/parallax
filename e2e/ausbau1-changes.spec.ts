/**
 * WP-117 (Ausbau 1): the side panel tab "Changes" (WP-113 on the git service of WP-111) against a real
 * git repository in the server's temp folder (FakeBackend, git runs for real):
 * - the test changes a tracked file and adds a new one; the filter "Only files of this session" hides
 *   both (the fake session touched no file), without it the list shows both with their diffs;
 * - a line comment with "+" and one with the keyboard (arrow key, C); "Send to Claude (2)" puts them as
 *   one paste chip into the composer, the comments fold away as "Sent", the paste goes out with the
 *   next prompt;
 * - commit with a message → nothing left to commit (scope "Uncommitted" empty), one commit ahead of
 *   the upstream (header and Push badge); Push → in sync (the bare remote has the commit);
 * - without a remote: Push stays available (it would set the upstream) and fails with a clean error
 *   in the panel (`GIT_PUSH_FAILED`, "Git reported an error.", git's detail).
 * Own server (worker) for the file; 1600 px wide, so the panel lies next to the transcript.
 */
import path from 'node:path';
import { expect, test } from './support/fixtures';
import { addBareRemote, findGit, initRepo, testGit, writeFiles } from './support/git';

test.use({ ownServer: 'a1changes', viewport: { width: 1600, height: 1000 } });

const COMMIT_MESSAGE = 'Update the readme and add notes';

test('changes tab: file list and diffs, line comments → paste chip, commit, ahead count, push; push without a remote fails cleanly', async ({
  app,
  server,
  page,
}) => {
  const gitPath = await findGit();
  test.skip(gitPath === null, 'no git on the PATH of this machine');
  if (gitPath === null) return;
  const repo = await server.makeProject('changes-repo');
  const git = await testGit(gitPath, server.root);
  await initRepo(git, repo, { 'README.md': '# Demo project\n\nline one\nline two\n' });
  await addBareRemote(git, repo, path.join(server.root, 'changes-remote.git'));

  const session = await app.newSession(repo);
  // Changes on disk after the session started (its diff base is HEAD at the start).
  await writeFiles(repo, {
    'README.md': '# Demo project\n\nline one\nline two changed\nline three\n',
    'notes.txt': 'first note\nsecond note\n',
  });

  await session.pane.locator('[data-slot="header-panel"][data-tab="changes"]').click();
  await expect(session.sidePanel).toHaveAttribute('data-tab', 'changes');
  const panel = session.sidePanel.locator(`[data-changes-panel="${session.key}"]`);
  await expect(panel.locator('[data-slot="changes-branch"]')).toHaveText('main');
  await expect(panel.locator('[data-slot="changes-upstream"]')).toHaveText('origin/main');

  // Default: only the files of this session – the fake session wrote none.
  await expect(panel.locator('[data-slot="changes-empty"]')).toBeVisible();
  await panel.locator('[data-slot="changes-scope-bar"] [role="switch"]').click();
  const files = panel.locator('[data-slot="changes-file"]');
  await expect(files).toHaveCount(2);
  await expect(panel.locator('[data-slot="changes-file"][data-path="README.md"]')).toHaveAttribute(
    'data-kind',
    'modified',
  );
  await expect(panel.locator('[data-slot="changes-file"][data-path="notes.txt"]')).toHaveAttribute(
    'data-kind',
    /added|untracked/,
  );

  // The diffs (up to 10 files are open): old and new lines with their numbers.
  const readmeDiff = panel.locator('[data-slot="changes-diff"][data-path="README.md"]');
  const changedLine = readmeDiff.locator('[data-diff-row][data-kind="add"][data-new-line="4"]');
  await expect(changedLine).toContainText('line two changed');
  await expect(readmeDiff.locator('[data-diff-row][data-kind="remove"]')).toContainText('line two');
  await expect(readmeDiff.locator('[data-diff-row][data-kind="add"][data-new-line="5"]')).toContainText(
    'line three',
  );
  const notesDiff = panel.locator('[data-slot="changes-diff"][data-path="notes.txt"]');
  await expect(notesDiff.locator('[data-diff-row][data-kind="add"]')).toHaveCount(2);

  // Comment 1: "+" on the line (shows on hover), Enter saves.
  const editor = panel.locator('[data-slot="review-editor"] textarea');
  await changedLine.hover();
  await changedLine.locator('[data-action="add-review-comment"]').click();
  await expect(editor).toBeFocused();
  await editor.fill('Why was this line changed?');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  const readmeComment = readmeDiff.locator('[data-slot="review-comment"]');
  await expect(readmeComment).toHaveAttribute('data-state', 'open');
  await expect(readmeComment).toContainText('Why was this line changed?');
  await expect(readmeComment).toContainText('README.md:4');

  // Comment 2: keyboard – focus the diff, arrow down to the first line, C.
  const notesLines = notesDiff.locator('[data-slot="changes-diff-lines"]');
  await notesLines.focus();
  await page.keyboard.press('ArrowDown');
  await expect(notesDiff.locator('[data-diff-row][data-cursor="true"]')).toContainText('first note');
  await page.keyboard.press('c');
  await expect(editor).toBeFocused();
  await editor.fill('Is the first note still needed?');
  await editor.press('Enter');
  await expect(notesDiff.locator('[data-slot="review-comment"]')).toContainText(
    'Is the first note still needed?',
  );
  await expect(
    panel.locator('[data-slot="changes-file"][data-path="notes.txt"] [data-slot="changes-file-comments"]'),
  ).toContainText('1');

  // "Send to Claude (2)": one paste chip in the composer, the comments are "Sent".
  const sendStatus = panel.locator('[data-slot="changes-send-status"]');
  await expect(sendStatus).toHaveText('2 open comments');
  await panel.locator('[data-action="send-review"]').click();
  const chips = session.composerRoot.locator('[data-slot="paste-chip"]');
  await expect(chips).toHaveCount(1);
  await expect(sendStatus).toHaveText('2 comments are in the message field.');
  await expect(panel.locator('[data-slot="review-comment-sent"]')).toHaveCount(2);
  await expect(panel.locator('[data-slot="review-comment"][data-state="open"]')).toHaveCount(0);
  await expect(panel.locator('[data-action="send-review"]')).toBeDisabled();
  // The chip goes out with the next prompt (the composer keeps its token; type behind it).
  await session.composer.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Please address these.');
  await page.keyboard.press('Enter');
  await expect(session.assistantText('Fake: received 1 paste(s)')).toBeVisible();
  await expect(chips).toHaveCount(0);

  // Commit everything: nothing left to commit, one commit ahead of the upstream.
  const commitBox = panel.locator('[data-slot="changes-commit"]');
  const commitButton = commitBox.locator('[data-action="git-commit"]');
  await expect(commitButton).toHaveText('Commit all 2 files');
  await commitBox.locator('textarea').fill(COMMIT_MESSAGE);
  await commitButton.click();
  await expect(panel.locator('[data-slot="changes-outcome"]')).toHaveText(/^Committed [0-9a-f]{7}\.$/);
  await expect(commitButton).toHaveText('Nothing to commit');
  await expect(commitButton).toBeDisabled();
  await expect(panel.locator('[data-slot="changes-ahead-behind"]')).toContainText('1 commit ahead');
  const push = panel.locator('[data-action="git-push"]');
  await expect(push.locator('[data-slot="push-ahead"]')).toContainText('1');
  expect((await git.run(repo, ['status', '--porcelain'])).trim()).toBe('');
  expect((await git.run(repo, ['log', '-1', '--format=%s'])).trim()).toBe(COMMIT_MESSAGE);
  // "Uncommitted" is empty now; the session scope still lists the committed files.
  await panel.locator('[data-slot="changes-scope-bar"] [data-scope="uncommitted"]').click();
  await expect(panel.locator('[data-slot="changes-empty"]')).toHaveText('No uncommitted changes.');
  await panel.locator('[data-slot="changes-scope-bar"] [data-scope="session"]').click();
  await expect(files).toHaveCount(2);

  // Push to the bare remote: in sync, nothing left to push.
  await push.click();
  await expect(panel.locator('[data-slot="changes-outcome"]')).toHaveText('Pushed.');
  await expect(push.locator('[data-slot="push-ahead"]')).toHaveCount(0);
  await expect(panel.locator('[data-slot="changes-ahead-behind"]')).toHaveCount(0);
  await expect(push).toBeDisabled();
  const remoteHead = await git.run(path.join(server.root, 'changes-remote.git'), ['rev-parse', 'main']);
  expect(remoteHead.trim()).toBe((await git.run(repo, ['rev-parse', 'HEAD'])).trim());

  // Without a remote: Push is offered (it would set the upstream) and fails with a clean error.
  await git.run(repo, ['remote', 'remove', 'origin']);
  await panel.locator('[data-action="changes-refresh"]').click();
  await expect(panel.locator('[data-slot="changes-upstream"]')).toHaveText('No upstream');
  await expect(push).toBeEnabled();
  await push.click();
  const error = panel.locator('[data-slot="changes-error"]');
  await expect(error).toHaveAttribute('data-code', 'GIT_PUSH_FAILED');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText('Push failed');
  await expect(error).toContainText('Git reported an error.');
  await expect(error).toContainText('Git: no remote');
});
