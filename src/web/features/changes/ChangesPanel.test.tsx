import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import {
  sampleGitDiffFile,
  sampleGitStatus,
  sampleId,
  sampleReviewComment,
  sampleStatusFacts,
  sampleSummary,
  sampleTime,
  sampleWorktreeRef,
} from '@shared/samples';
import { registerShellRequestHandler, type ShellRequest } from '@web/shell/requests';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { ChangesPanel } from './ChangesPanel';
import { resetReviewDrafts } from './state/draft';
import { resetChangesViews } from './state/view';
import { CHANGES_ROOT, CHANGES_SESSION_KEY, longPatch, startChangesHost, type ChangesHost } from './testing';

// Typing into editors and menus; generous under parallel load.
vi.setConfig({ testTimeout: 30_000 });

let running: ChangesHost | null = null;
let requests: ShellRequest[];
const removers: (() => void)[] = [];

/** Collects shell requests of `kind` (handled = true). */
function capture(kind: ShellRequest['kind']): void {
  removers.push(
    registerShellRequestHandler(kind, (request) => {
      requests.push(request);
      return true;
    }),
  );
}

function start(options: Parameters<typeof startChangesHost>[0] = {}): ChangesHost {
  running = startChangesHost(options);
  return running;
}

function host(): ChangesHost {
  if (running === null) throw new Error('no host');
  return running;
}

function renderPanel() {
  return render(
    <TooltipProvider>
      <ChangesPanel sessionKey={CHANGES_SESSION_KEY} />
    </TooltipProvider>,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}

/** The panel showed the list and the (default-open) diff of src/login.ts. */
async function ready(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Diff of src/login.ts' });
}

/** The comment matching new lines 11–12 of the sample patch. */
const QUOTE = '  if (password.length > 0) {\n    submit();';

beforeEach(() => {
  requests = [];
  resetChangesViews();
  resetReviewDrafts();
});

afterEach(() => {
  cleanup();
  for (const remove of removers.splice(0)) remove();
  running?.stop();
  running = null;
  resetClientStore();
});

describe('ChangesPanel – status and list (WP-113)', () => {
  it('shows branch, upstream, ahead/behind, the files with status and stats, and loads the session diff', async () => {
    start({ git: { status: sampleGitStatus({ root: CHANGES_ROOT, ahead: 2, behind: 1 }) } });
    renderPanel();
    await ready();
    expect(screen.getByText('feature/login')).toBeTruthy();
    expect(screen.getByText('origin/feature/login')).toBeTruthy();
    expect(screen.getByText('2 commits ahead')).toBeTruthy();
    expect(screen.getByText('1 commit behind')).toBeTruthy();
    const row = document.querySelector<HTMLElement>('[data-slot="changes-file"][data-path="src/login.ts"]');
    expect(row).not.toBeNull();
    expect(within(row ?? document.body).getByText('Modified')).toBeTruthy();
    expect(within(row ?? document.body).getByText('2 lines added')).toBeTruthy();
    expect(within(row ?? document.body).getByText('1 line removed')).toBeTruthy();
    expect(screen.getByText('since 0000000')).toBeTruthy();
    // Without a worktree: scope "session" with the filter "only files of this session" (default on).
    expect(host().commands('git.diff')[0]).toMatchObject({ scope: 'session', onlySessionFiles: true });
    expect(
      screen.getByRole('switch', { name: 'Only files of this session' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(host().commands('git.fileDiff')[0]).toMatchObject({ scope: 'session', path: 'src/login.ts' });
    // Line numbers of both sides.
    const added = document.querySelector('[data-diff-row][data-new-line="12"]');
    expect(added?.getAttribute('data-kind')).toBe('add');
    expect(added?.textContent).toContain('submit();');
  });

  it('a worktree session has no filter and compares everything since its base', async () => {
    start({ summary: { worktree: sampleWorktreeRef() } });
    renderPanel();
    await ready();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(host().commands('git.diff')[0]).toMatchObject({ onlySessionFiles: false });
  });

  it('switches the scope and the filter (a new git.diff each)', async () => {
    const user = userEvent.setup();
    start();
    renderPanel();
    await ready();
    await user.click(screen.getByRole('radio', { name: 'Uncommitted' }));
    await waitFor(() => {
      expect(host().commands('git.diff').at(-1)).toMatchObject({
        scope: 'uncommitted',
        onlySessionFiles: true,
      });
    });
    await user.click(screen.getByRole('switch', { name: 'Only files of this session' }));
    await waitFor(() => {
      expect(host().commands('git.diff').at(-1)).toMatchObject({
        scope: 'uncommitted',
        onlySessionFiles: false,
      });
    });
    expect(
      screen.getByText('All changes in the folder are shown, also those of other sessions.'),
    ).toBeTruthy();
  });

  it('opens a file in the viewer with its absolute path; a file diff closes and opens again', async () => {
    const user = userEvent.setup();
    capture('openFile');
    start();
    renderPanel();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Open login.ts' }));
    expect(requests).toEqual([
      { kind: 'openFile', sessionKey: CHANGES_SESSION_KEY, path: 'D:\\work\\sample\\src\\login.ts' },
    ]);
    const toggle = document.querySelector<HTMLElement>('[data-slot="changes-file-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    if (toggle === null) throw new Error('toggle missing');
    await user.click(toggle);
    expect(screen.queryByRole('region', { name: 'Diff of src/login.ts' })).toBeNull();
    await user.click(toggle);
    await ready();
  });

  it('marks binary files, cut-off diffs and virtualizes long ones', async () => {
    start({
      git: {
        files: [
          sampleGitDiffFile({
            path: 'logo.png',
            kind: 'added',
            binary: true,
            patch: null,
            additions: 0,
            deletions: 0,
          }),
          sampleGitDiffFile({
            path: 'big.txt',
            kind: 'added',
            patch: longPatch(400),
            additions: 400,
            deletions: 0,
            truncated: true,
          }),
        ],
      },
    });
    renderPanel();
    expect(await screen.findByText('Binary file – no diff to show.')).toBeTruthy();
    const region = await screen.findByRole('region', { name: 'Diff of big.txt' });
    expect(region.getAttribute('data-virtualized')).toBe('true');
    expect(screen.getByText('The diff is too large and was cut off.')).toBeTruthy();
    // Only one file may be loaded per binary: none for logo.png.
    expect(
      host()
        .commands('git.fileDiff')
        .map((cmd) => cmd.path),
    ).toEqual(['big.txt']);
  });

  it('says when the folder is no repository, and when the computer has no git service', async () => {
    start({
      git: {
        status: sampleGitStatus({
          isRepo: false,
          root: null,
          branch: null,
          head: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
        }),
      },
    });
    const view = renderPanel();
    expect(
      await screen.findByText('The folder of this session is not part of a Git repository.'),
    ).toBeTruthy();
    view.unmount();
    host().stop();
    start({ hostState: { features: { git: false, search: false, overview: false } } });
    renderPanel();
    await settle();
    expect(
      screen.getByText('The computer of this session has no Git service. Update Parallax there.'),
    ).toBeTruthy();
    expect(host().commands('git.status')).toEqual([]);
  });

  it('loads again after a turn of the session ended', async () => {
    start();
    renderPanel();
    await ready();
    const before = host().commands('git.status').length;
    act(() => {
      host().host.upsertSummary(
        sampleSummary({
          cwd: CHANGES_ROOT,
          status: sampleStatusFacts({
            lastTurn: { outcome: 'success', endedAt: sampleTime(500), durationMs: 1000 },
          }),
        }),
      );
    });
    await waitFor(() => {
      expect(host().commands('git.status').length).toBe(before + 1);
    });
  });
});

describe('ChangesPanel – review comments (WP-113, ADR-254)', () => {
  it('"+" on a line opens the editor; Enter saves the comment (review.add) and shows it below the line', async () => {
    const user = userEvent.setup();
    start();
    renderPanel();
    await ready();
    const row = document.querySelector<HTMLElement>('[data-diff-row][data-new-line="12"]');
    if (row === null) throw new Error('row missing');
    await user.click(within(row).getByRole('button', { name: 'Comment on line 12' }));
    const editor = await screen.findByRole('textbox', { name: 'Comment on src/login.ts:12' });
    await user.type(editor, 'Needs a test.{Shift>}{Enter}{/Shift}Please.{Enter}');
    await waitFor(() => {
      expect(host().commands('review.add')).toHaveLength(1);
    });
    expect(host().commands('review.add')[0]).toMatchObject({
      path: 'src/login.ts',
      side: 'new',
      line: 12,
      endLine: 12,
      quote: '    submit();',
      text: 'Needs a test.\nPlease.',
    });
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Comment on src/login.ts:12' })).toBeNull();
    });
    const note = await screen.findByText(/Needs a test\./);
    expect(note.closest('[data-diff-row]')?.getAttribute('data-new-line')).toBe('12');
  });

  it('Esc cancels the editor without saving (and keeps the panel)', async () => {
    const user = userEvent.setup();
    start();
    renderPanel();
    const region = await ready();
    const row = region.querySelector<HTMLElement>('[data-new-line="11"]');
    if (row === null) throw new Error('row missing');
    await user.click(within(row).getByRole('button', { name: 'Comment on line 11' }));
    const editor = await screen.findByRole('textbox', { name: 'Comment on src/login.ts:11' });
    // The window's shortcut listener (Esc closes the side panel) never sees an unhandled Esc.
    let leaked = false;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) leaked = true;
    };
    window.addEventListener('keydown', listener);
    await user.type(editor, 'draft{Escape}');
    window.removeEventListener('keydown', listener);
    expect(leaked).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Comment on src/login.ts:11' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Diff of src/login.ts' })).toBeTruthy();
    expect(host().commands('review.add')).toEqual([]);
  });

  it('keyboard: arrow keys move the line cursor, Shift extends it, C comments the range', async () => {
    const user = userEvent.setup();
    start();
    renderPanel();
    const region = await ready();
    region.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.querySelector('[data-cursor="true"]')?.getAttribute('data-new-line')).toBe('10');
    expect(document.querySelector('[data-slot="changes-diff-announce"]')?.textContent).toBe(
      'Line 10: export function login(password: string) {',
    );
    await user.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(document.querySelector('[data-slot="changes-diff-announce"]')?.textContent).toBe(
      'Lines 10 to 11 selected',
    );
    await user.keyboard('c');
    const editor = await screen.findByRole('textbox', { name: 'Comment on src/login.ts:10-11' });
    await user.type(editor, 'Explain.{Enter}');
    await waitFor(() => {
      expect(host().commands('review.add')[0]).toMatchObject({
        side: 'new',
        line: 10,
        endLine: 11,
        quote: 'export function login(password: string) {\n  if (password.length > 0) {',
      });
    });
  });

  it('edits and deletes a comment', async () => {
    const user = userEvent.setup();
    const comment = sampleReviewComment({ line: 11, endLine: 12, quote: QUOTE, text: 'First words.' });
    start({ review: [comment] });
    renderPanel();
    await ready();
    expect(await screen.findByText('First words.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Edit comment' }));
    const editor = await screen.findByRole('textbox', { name: 'Comment on src/login.ts:11-12' });
    await user.clear(editor);
    await user.type(editor, 'Better words.{Enter}');
    await waitFor(() => {
      expect(host().commands('review.update')).toContainEqual(
        expect.objectContaining({ commentId: comment.id, text: 'Better words.' }),
      );
    });
    expect(await screen.findByText('Better words.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete comment' }));
    await waitFor(() => {
      expect(screen.queryByText('Better words.')).toBeNull();
    });
    expect(host().commands('review.remove')[0]).toMatchObject({ commentIds: [comment.id] });
  });

  it('re-anchors moved comments and marks lost ones stale – only in the session scope', async () => {
    const user = userEvent.setup();
    const moved = sampleReviewComment({
      id: sampleId('rc', 1),
      line: 40,
      endLine: 40,
      quote: '    submit();',
      text: 'Moved.',
    });
    const lost = sampleReviewComment({
      id: sampleId('rc', 2),
      line: 12,
      endLine: 12,
      quote: 'removed()',
      text: 'Lost.',
    });
    start({ review: [moved, lost] });
    renderPanel();
    await ready();
    await waitFor(() => {
      expect(host().commands('review.update')).toHaveLength(2);
    });
    expect(host().commands('review.update')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ commentId: moved.id, line: 12, endLine: 12 }),
        expect.objectContaining({ commentId: lost.id, state: 'stale' }),
      ]),
    );
    const movedNote = (await screen.findByText('Moved.')).closest('[data-diff-row]');
    expect(movedNote?.getAttribute('data-new-line')).toBe('12');
    const lostNote = screen.getByText('Lost.').closest<HTMLElement>('[data-slot="review-comment"]');
    expect(lostNote?.getAttribute('data-state')).toBe('stale');
    expect(within(lostNote ?? document.body).getByText('Outdated')).toBeTruthy();

    // Another scope never changes the stored anchors.
    const updates = host().commands('review.update').length;
    host().git.files = [sampleGitDiffFile({ patch: '@@ -1 +1 @@\n-a\n+b\n' })];
    await user.click(screen.getByRole('radio', { name: 'Staged' }));
    await waitFor(() => {
      expect(host().commands('git.fileDiff').at(-1)).toMatchObject({ scope: 'staged' });
    });
    await settle();
    expect(host().commands('review.update')).toHaveLength(updates);
  });

  it('"Send to Claude (n)" puts the open comments into the composer as a paste chip, then marks them sent', async () => {
    const user = userEvent.setup();
    capture('composerText');
    const first = sampleReviewComment({
      id: sampleId('rc', 1),
      line: 11,
      endLine: 12,
      quote: QUOTE,
      text: 'One.',
    });
    const second = sampleReviewComment({
      id: sampleId('rc', 2),
      line: 14,
      endLine: 14,
      quote: '}',
      text: 'Two.',
    });
    const sent = sampleReviewComment({
      id: sampleId('rc', 3),
      line: 10,
      endLine: 10,
      quote: 'export',
      text: 'Old news.',
      state: 'sent',
      sentAt: sampleTime(40),
    });
    start({ review: [first, second, sent] });
    renderPanel();
    await ready();
    expect(screen.getByText('2 open comments')).toBeTruthy();
    // A sent comment is folded to one line.
    expect(document.querySelectorAll('[data-slot="review-comment-sent"]')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Send to Claude/ }));
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request?.kind !== 'composerText') throw new Error('no composerText');
    expect(request.asPaste).toBe(true);
    expect(request.sessionKey).toBe(CHANGES_SESSION_KEY);
    expect(request.text).toBe(
      [
        'Review comments on the changes (2):',
        `1. src/login.ts:11-12\n   >   if (password.length > 0) {\n   >     submit();\n   One.`,
        '2. src/login.ts:14\n   > }\n   Two.',
      ].join('\n\n'),
    );
    await waitFor(() => {
      expect(host().commands('review.markSent')[0]).toMatchObject({ commentIds: [first.id, second.id] });
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-slot="review-comment-sent"]')).toHaveLength(3);
    });
    expect(screen.getByText('2 comments are in the message field.')).toBeTruthy();
  });

  it('a mouse selection over lines plus C comments the selected lines', async () => {
    start();
    renderPanel();
    const region = await ready();
    const from = region.querySelector('[data-new-line="11"]');
    const to = region.querySelector('[data-new-line="13"]');
    const fromText = from?.querySelector('.whitespace-pre-wrap')?.firstChild;
    const toText = to?.querySelector('.whitespace-pre-wrap')?.firstChild;
    if (fromText === undefined || fromText === null || toText === undefined || toText === null) {
      throw new Error('rows missing');
    }
    const range = document.createRange();
    range.setStart(fromText, 2);
    range.setEnd(toText, 1);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    region.focus();
    fireEvent.keyDown(region, { key: 'c' });
    expect(await screen.findByRole('textbox', { name: 'Comment on src/login.ts:11-13' })).toBeTruthy();
  });

  it('leaves a comment newer than the loaded diff alone (another window may hold a newer one)', async () => {
    const newer = sampleReviewComment({
      line: 12,
      endLine: 12,
      quote: 'only in a newer diff',
      text: 'Newer.',
      createdAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    start({ review: [newer] });
    renderPanel();
    await ready();
    const note = (await screen.findByText('Newer.')).closest<HTMLElement>('[data-slot="review-comment"]');
    await settle();
    expect(host().commands('review.update')).toEqual([]);
    expect(note?.getAttribute('data-state')).toBe('open');
  });

  it('lists comments on files the list does not show, with their quote', async () => {
    const elsewhere = sampleReviewComment({
      path: 'src/other.ts',
      quote: 'const x = 1;',
      text: 'Elsewhere.',
    });
    start({ review: [elsewhere] });
    renderPanel();
    await ready();
    const section = await screen.findByRole('region', { name: 'Comments on files that are not listed' });
    expect(within(section).getByText('Elsewhere.')).toBeTruthy();
    expect(within(section).getByText('const x = 1;')).toBeTruthy();
    expect(within(section).getByText('src/other.ts:12-13')).toBeTruthy();
  });

  it('without a composer nothing is marked sent', async () => {
    const user = userEvent.setup();
    start({ review: [sampleReviewComment({ line: 11, endLine: 12, quote: QUOTE })] });
    renderPanel();
    await ready();
    await user.click(screen.getByRole('button', { name: /Send to Claude/ }));
    expect(screen.getByRole('alert').textContent).toContain(
      'The message field of this session is not available right now.',
    );
    expect(host().commands('review.markSent')).toEqual([]);
  });
});

describe('ChangesPanel – git bar (WP-113, F4)', () => {
  it('commits all changes, or the picked files, and loads again', async () => {
    const user = userEvent.setup();
    start();
    renderPanel();
    await ready();
    const before = host().commands('git.status').length;
    const message = screen.getByRole('textbox', { name: 'Commit message' });
    await user.type(message, 'Add the login check');
    await user.click(screen.getByRole('button', { name: 'Commit 1 file' }));
    await waitFor(() => {
      expect(host().commands('git.commit')[0]).toEqual(
        expect.objectContaining({ message: 'Add the login check' }),
      );
    });
    expect(host().commands('git.commit')[0]).not.toHaveProperty('paths');
    expect(await screen.findByText('Committed 0000000.')).toBeTruthy();
    await waitFor(() => {
      expect(host().commands('git.status').length).toBeGreaterThan(before);
    });

    await user.click(screen.getByRole('checkbox', { name: 'Commit src/login.ts' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Commit message' }),
      'Only this one{Control>}{Enter}{/Control}',
    );
    await waitFor(() => {
      expect(host().commands('git.commit')[1]).toMatchObject({
        message: 'Only this one',
        paths: ['src/login.ts'],
      });
    });
  });

  it('creates and switches a branch from the branch menu; an invalid name cannot be used', async () => {
    const user = userEvent.setup();
    start();
    renderPanel();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Branch' }));
    const input = await screen.findByRole('textbox', { name: 'Branch name' });
    await user.type(input, 'bad name');
    expect(screen.getByText('Not a valid branch name.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create and switch' }).hasAttribute('disabled')).toBe(true);
    await user.clear(input);
    await user.type(input, 'feature/next{Enter}');
    await waitFor(() => {
      expect(host().commands('git.branchCreate')[0]).toMatchObject({ branch: 'feature/next', switch: true });
    });
    expect(await screen.findByText('Switched to feature/next.')).toBeTruthy();
  });

  it('a push refused at the sign-in offers "Push in terminal" (terminal tab plus the git push hint)', async () => {
    const user = userEvent.setup();
    capture('sidePanel');
    start({
      hostState: { terminalAvailable: true },
      onCommand: (cmd) =>
        cmd.name === 'git.push'
          ? {
              ok: false,
              error: makeError('GIT_PUSH_FAILED', { reason: 'auth', detail: 'Authentication failed' }),
            }
          : undefined,
    });
    renderPanel();
    await ready();
    await user.click(screen.getByRole('button', { name: /^Push/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Push failed');
    expect(alert.textContent).toContain('Git could not sign in to the remote.');
    expect(alert.textContent).toContain('Git: Authentication failed');
    expect(alert.textContent).toContain('git push');
    await user.click(within(alert).getByRole('button', { name: 'Push in terminal' }));
    expect(requests).toEqual([{ kind: 'sidePanel', sessionKey: CHANGES_SESSION_KEY, tab: 'terminal' }]);
  });

  it('without an upstream Push names the remote it sets; without any remote it is disabled', async () => {
    start({ git: { status: sampleGitStatus({ root: CHANGES_ROOT, upstream: null, pushRemote: 'origin' }) } });
    const view = renderPanel();
    await ready();
    const push = screen.getByRole('button', { name: /^Push/ });
    expect(push.hasAttribute('disabled')).toBe(false);
    expect(push.getAttribute('title')).toBe('Push to origin and set the upstream');
    expect(screen.getByText('No upstream')).toBeTruthy();
    view.unmount();
    host().stop();

    start({ git: { status: sampleGitStatus({ root: CHANGES_ROOT, upstream: null, pushRemote: null }) } });
    renderPanel();
    await ready();
    const disabled = screen.getByRole('button', { name: /^Push/ });
    expect(disabled.hasAttribute('disabled')).toBe(true);
    expect(disabled.getAttribute('title')).toBe('No remote to push to – add one with git remote add');
    expect(screen.getByText('No remote')).toBeTruthy();
    expect(host().commands('git.push')).toEqual([]);
  });
});
