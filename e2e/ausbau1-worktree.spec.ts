/**
 * WP-117 (Ausbau 1): sessions in their own git worktree (WP-114 on the server of WP-111) against a real
 * repository in the server's temp folder (FakeBackend, git runs for real):
 * - "New session" for a folder in a repository shows the switch "In its own worktree"; on, with a
 *   branch name → the session runs in `<repo>/.claude/worktrees/<branch, / → ->` (git knows the
 *   worktree, the server reports it as `cwd`), its row shows the branch with the worktree symbol and,
 *   grouped by project, sits in the group of the repository next to a normal session there;
 * - archiving it opens the cleanup dialog (folder, clean, nothing unpushed, three options); "Delete
 *   the worktree and the branch" removes folder and branch, the session is archived;
 * - a project setting with a setup command (`echo …`, set in Settings → Projects): the next worktree
 *   session runs it visibly in a terminal tab "Setup" (the FakeBackend's echo shell stands in for the
 *   pseudo console) and starts normally once it ended with exit code 0.
 * Own server (worker) for the file.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { ParallaxApp, SessionView } from './support/app';
import { expect, test } from './support/fixtures';
import { findGit, initRepo, serverSummaries, testGit, type TestGit } from './support/git';
import { serverSettings } from './support/server';

test.use({ ownServer: 'a1worktree' });

/** Windows compares paths case-insensitively; Linux exactly. */
function samePath(a: string, b: string): boolean {
  const norm = (value: string) => path.resolve(value);
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Short names of the branches of `repo`. */
async function branches(git: TestGit, repo: string): Promise<string[]> {
  const out = await git.run(repo, ['branch', '--format=%(refname:short)']);
  return out.split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** "New session" for `repo` with the switch "In its own worktree" on and branch `branch`. */
async function newWorktreeSession(
  app: ParallaxApp,
  page: Page,
  repo: string,
  branch: string,
): Promise<SessionView> {
  const before = await app.selectedSessionKey();
  await page.locator('[data-action="new-session"]').click();
  const dialog = page.locator('[data-slot="new-session-dialog"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="cwd"]').fill(repo);
  // The switch shows once the server confirmed the repository (`worktree.list`).
  const block = dialog.locator('[data-slot="new-session-worktree"]');
  await expect(block).toHaveAttribute('data-on', 'false');
  await block.getByRole('switch').click();
  await expect(block).toHaveAttribute('data-on', 'true');
  const branchField = dialog.locator('input[name="worktreeBranch"]');
  await expect(branchField).toHaveValue(/^parallax\/[a-z0-9]{6}$/);
  await branchField.fill(branch);
  await expect(dialog.locator('[data-slot="worktree-folder"]')).toContainText(branch.replaceAll('/', '-'));
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  const key = await app.waitForSelection((k) => k !== null && k !== before);
  const session = app.session(key);
  await expect(session.pane).toBeVisible();
  return session;
}

test('worktree session: own folder under .claude/worktrees, grouped under the repository with its branch; archive → cleanup deletes worktree and branch', async ({
  app,
  server,
  page,
}) => {
  const gitPath = await findGit();
  test.skip(gitPath === null, 'no git on the PATH of this machine');
  if (gitPath === null) return;
  const git = await testGit(gitPath, server.root);
  const repo = await server.makeProject('wt-repo');
  await initRepo(git, repo, { 'README.md': '# Worktree demo\n' });

  // A normal session in the repository first (its group), then one in its own worktree.
  const plain = await app.newSession(repo);
  const session = await newWorktreeSession(app, page, repo, 'e2e/wt-one');
  const folder = path.join(repo, '.claude', 'worktrees', 'e2e-wt-one');

  // Created asynchronously ("Creating the worktree …"), then the banner goes.
  await expect(session.pane.locator('[data-slot="worktree-notice"]')).toHaveCount(0);
  await expect.poll(() => exists(folder)).toBe(true);
  expect(await branches(git, repo)).toContain('e2e/wt-one');
  const listed = await git.run(repo, ['worktree', 'list', '--porcelain']);
  expect(
    listed.split(/\r?\n/).some((line) => line.startsWith('worktree ') && samePath(line.slice(9), folder)),
  ).toBe(true);
  // The server runs the session in the worktree folder.
  const summary = (await serverSummaries(server)).find((s) => session.key.endsWith(s.entryId));
  expect(summary?.worktree?.branch).toBe('e2e/wt-one');
  expect(samePath(summary?.cwd ?? '', folder)).toBe(true);
  expect(samePath(summary?.worktree?.repoRoot ?? '', repo)).toBe(true);
  // The session starts there with the first message.
  await session.send('hello worktree');
  await expect(session.assistantText('Echo: hello worktree')).toBeVisible();

  // Sidebar: the branch with the worktree symbol; grouped by project under the repository.
  const branchLabel = app.row(session.key).locator('[data-slot="row-branch"]');
  await expect(branchLabel).toHaveAttribute('data-worktree', 'true');
  await expect(branchLabel).toContainText('e2e/wt-one');
  await page.locator('[data-slot="sidebar-mode"]').click();
  await expect(app.sidebar()).toHaveAttribute('data-view', 'grouped');
  const groups = app.sidebar().getByRole('group');
  await expect(groups).toHaveCount(1);
  await expect(groups.locator('[data-session-row]')).toHaveCount(2);
  await expect(groups.locator('[data-group-toggle]')).toContainText(path.basename(repo));
  await expect(groups.locator(`[data-session-row="${plain.key}"]`)).toBeVisible();

  // Archive → cleanup dialog: clean, nothing unpushed, three options; delete worktree and branch.
  await app.rowAction(session.key, 'archive');
  const dialog = page.locator('[data-slot="worktree-cleanup"]');
  await expect(dialog).toHaveAttribute('data-then', 'archive');
  const inspection = dialog.locator('[data-slot="cleanup-inspection"]');
  await expect(inspection).toContainText('No uncommitted changes');
  await expect(inspection).toContainText('No commits that exist only here');
  await expect(inspection).toContainText('The branch is merged into main');
  const options = dialog.locator('[data-slot="cleanup-options"] [role="radio"]');
  await expect(options).toHaveCount(3);
  await dialog.locator('[data-slot="cleanup-options"] [role="radio"][value="all"]').click();
  await expect(dialog.locator('[data-slot="cleanup-options"] [role="radio"][value="all"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(dialog.locator('[data-slot="cleanup-confirm"]')).toHaveCount(0);
  await dialog.locator('[data-action="cleanup-confirm"]').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => exists(folder)).toBe(false);
  expect(await branches(git, repo)).not.toContain('e2e/wt-one');
  // Archived: gone from the list, still known to the server (without its worktree).
  await expect(app.row(session.key)).toHaveCount(0);
  const archived = (await serverSummaries(server)).find((s) => session.key.endsWith(s.entryId));
  expect(archived?.archived).toBe(true);
  expect(archived?.worktree).toBeNull();
});

test('project setup command: the next worktree session runs it in a terminal tab "Setup" and starts afterwards', async ({
  app,
  server,
  page,
}) => {
  const gitPath = await findGit();
  test.skip(gitPath === null, 'no git on the PATH of this machine');
  if (gitPath === null) return;
  const git = await testGit(gitPath, server.root);
  const repo = await server.makeProject('wt-setup');
  await initRepo(git, repo, { 'README.md': '# Setup demo\n' });
  // A session in the repository lists it in Settings → Projects.
  await app.newSession(repo);

  const settings = await app.openSettingsPage('projects');
  const project = settings.locator('[data-slot="projects-section"] li[data-project]').filter({
    hasText: path.basename(repo),
  });
  await expect(project).toHaveCount(1);
  await project.getByRole('button').first().click();
  const setup = project.getByLabel('Setup command');
  await setup.fill('echo setup-ok');
  await setup.press('Tab');
  await expect
    .poll(async () => Object.values((await serverSettings(server)).projects).map((p) => p.setup))
    .toEqual(['echo setup-ok']);
  await expect(project).toContainText('Setup');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-slot="settings-page"]')).toHaveCount(0);

  const session = await newWorktreeSession(app, page, repo, 'e2e/wt-setup');
  // Setup ran (exit 0): no banner left, a terminal tab "Setup" with its output.
  await expect(session.pane.locator('[data-slot="worktree-notice"]')).toHaveCount(0);
  await session.composer.click();
  await page.keyboard.press('Alt+T');
  const terminals = session.pane.locator('[data-slot="terminal-panel"]');
  const setupTab = terminals.locator('[data-slot="terminal-tab"]').filter({ hasText: 'Setup' });
  await expect(setupTab).toHaveCount(1);
  await setupTab.click();
  await expect(
    terminals.locator('[data-slot="terminal-view"][data-active="true"] .xterm-rows'),
  ).toContainText('setup-ok');
  // The session starts normally afterwards.
  await session.send('hello after setup');
  await expect(session.assistantText('Echo: hello after setup')).toBeVisible();
});
