import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey } from '@shared/common';
import { makeError, type ErrorPayload } from '@shared/errors';
import type { ProjectSettingsMap, WorktreeInspection } from '@shared/model';
import type { Command } from '@shared/protocol';
import {
  sampleHostState,
  sampleId,
  sampleProjectSettings,
  sampleSettings,
  sampleStatusFacts,
  sampleSummary,
  sampleWorktreeInspection,
  sampleWorktreeRef,
} from '@shared/samples';
import { startNewSessionDemo, type NewSessionDemo } from '@web/shell/new-session/demo-host';
import { requestShell } from '@web/shell/requests';
import type { FakeAck } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { WORKTREE_SLOTS } from './index';

/**
 * WP-114: the slot `WorktreeCleanup` – takes `worktree.cleanup` only for worktree sessions, checks the
 * worktree (`worktree.inspect`), keeps it by default while work is open, asks before discarding it,
 * deletes it (`session.close` first, then `worktree.remove`), answers WORKTREE_DIRTY and a failed
 * teardown with "Delete anyway", then archives or removes the session.
 */

vi.setConfig({ testTimeout: 60_000 });

const WORKTREE_ENTRY = sampleId('en', 2);
const PLAIN_ENTRY = sampleId('en', 3);
const KEY = makeSessionKey(LOCAL_HOST_ID, WORKTREE_ENTRY);
const PLAIN_KEY = makeSessionKey(LOCAL_HOST_ID, PLAIN_ENTRY);
const STEPS = new Set(['session.close', 'worktree.remove', 'session.setArchived', 'session.remove']);

let demo: NewSessionDemo | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  resetClientStore();
});

interface Options {
  inspection?: WorktreeInspection | ErrorPayload;
  /** Answers of `worktree.remove`, in order (missing = ok). */
  removeErrors?: ErrorPayload[];
  archiveError?: ErrorPayload;
  git?: boolean;
  projects?: ProjectSettingsMap;
  runState?: 'idle' | 'sleeping';
}

async function start(options: Options = {}): Promise<NewSessionDemo> {
  const removeErrors = [...(options.removeErrors ?? [])];
  let archiveError = options.archiveError;
  demo = startNewSessionDemo({
    immediate: true,
    hostState: sampleHostState({
      terminalAvailable: true,
      features: { git: options.git ?? true, search: false, overview: false },
      settings: sampleSettings({ projects: options.projects ?? {} }),
    }),
    summaries: [
      sampleSummary({
        entryId: WORKTREE_ENTRY,
        title: 'Login form',
        cwd: sampleWorktreeRef().path,
        worktree: sampleWorktreeRef(),
        status: sampleStatusFacts({ runState: options.runState ?? 'idle' }),
      }),
      sampleSummary({ entryId: PLAIN_ENTRY, title: 'Plain' }),
    ],
    onCommand: (cmd: Command): FakeAck | undefined => {
      if (cmd.name === 'worktree.inspect') {
        const answer =
          options.inspection ??
          sampleWorktreeInspection({ dirtyFiles: 0, unpushedCommits: 0, branchMerged: true });
        return 'code' in answer ? { ok: false, error: answer } : { ok: true, result: answer };
      }
      if (cmd.name === 'worktree.remove') {
        const error = removeErrors.shift();
        return error === undefined ? { ok: true, result: {} } : { ok: false, error };
      }
      if (cmd.name === 'session.setArchived' && archiveError !== undefined) {
        const error = archiveError;
        archiveError = undefined;
        return { ok: false, error };
      }
      return undefined;
    },
  });
  const running = demo;
  await waitFor(() => {
    expect(running.connection.status()).toBe('open');
  });
  const { WorktreeCleanup } = WORKTREE_SLOTS;
  render(
    <TooltipProvider>
      <WorktreeCleanup />
    </TooltipProvider>,
  );
  return running;
}

function steps(running: NewSessionDemo): Command[] {
  return running.host.commands.filter((cmd) => STEPS.has(cmd.name));
}

function ask(sessionKey: string, then: 'archive' | 'remove'): boolean {
  let taken = false;
  act(() => {
    taken = requestShell({ kind: 'worktree.cleanup', sessionKey, then });
  });
  return taken;
}

async function openDialog(then: 'archive' | 'remove' = 'archive'): Promise<HTMLElement> {
  expect(ask(KEY, then)).toBe(true);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => {
    expect(dialog.querySelector('[data-slot="cleanup-checking"]')).toBeNull();
  });
  return dialog;
}

function option(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByRole('radio', { name });
}

describe('WorktreeCleanup (WP-114)', () => {
  it('takes the request only for a worktree session on a host with the git service', async () => {
    await start({ git: false });
    expect(ask(KEY, 'archive')).toBe(false);
    expect(ask(PLAIN_KEY, 'archive')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a clean, merged worktree: deleted with its branch by default, after closing the process; then archived', async () => {
    const running = await start();
    const user = userEvent.setup();
    const dialog = await openDialog();
    expect(within(dialog).getByRole('heading', { name: 'Archive “Login form”?' })).toBeTruthy();
    expect(dialog.querySelector('[data-slot="cleanup-inspection"]')?.textContent).toContain(
      'The branch is merged into main',
    );
    expect(option(dialog, 'Delete the worktree and the branch').getAttribute('aria-checked')).toBe('true');
    expect(dialog.querySelector('[data-slot="cleanup-confirm"]')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(steps(running)).toEqual([
      { name: 'session.close', entryId: WORKTREE_ENTRY },
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: true,
        force: false,
        skipTeardown: false,
      },
      { name: 'session.setArchived', entryId: WORKTREE_ENTRY, archived: true },
    ]);
  });

  it('open work: keeps the worktree by default; discarding it needs the check box and sends force', async () => {
    const running = await start({ inspection: sampleWorktreeInspection(), runState: 'sleeping' });
    const user = userEvent.setup();
    const dialog = await openDialog();
    const facts = dialog.querySelector('[data-slot="cleanup-inspection"]')?.textContent ?? '';
    expect(facts).toContain('2 files with uncommitted changes');
    expect(facts).toContain('1 commit that is in no remote branch');
    expect(option(dialog, 'Keep the worktree').getAttribute('aria-checked')).toBe('true');
    await user.click(option(dialog, 'Delete the worktree, keep the branch'));
    expect(dialog.querySelector('[data-slot="cleanup-confirm"]')?.textContent).toContain('(2 changed files)');
    await user.click(option(dialog, 'Delete the worktree and the branch'));
    const confirm = within(dialog).getByRole('checkbox', {
      name: /discard the open work \(2 changed files, 1 commit\)/,
    });
    const archive = within(dialog).getByRole('button', { name: 'Archive' });
    expect(archive).toHaveProperty('disabled', true);
    await user.click(confirm);
    await user.click(archive);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // Sleeping: no process to close first.
    expect(steps(running)).toEqual([
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: true,
        force: true,
        skipTeardown: false,
      },
      { name: 'session.setArchived', entryId: WORKTREE_ENTRY, archived: true },
    ]);
  });

  it('"Keep the worktree" only archives', async () => {
    const running = await start({ inspection: sampleWorktreeInspection(), runState: 'sleeping' });
    const user = userEvent.setup();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(steps(running)).toEqual([
      { name: 'session.setArchived', entryId: WORKTREE_ENTRY, archived: true },
    ]);
  });

  it('WORKTREE_DIRTY from the server: the open work shows, "Delete anyway" sends force', async () => {
    const running = await start({
      runState: 'sleeping',
      removeErrors: [makeError('WORKTREE_DIRTY', { dirtyFiles: 3, unpushedCommits: 0 })],
    });
    const user = userEvent.setup();
    const dialog = await openDialog('remove');
    expect(within(dialog).getByRole('heading', { name: 'Remove “Login form” from Parallax?' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('The worktree has open work: 3 changed files.');
    expect(dialog.querySelector('[data-slot="cleanup-inspection"]')?.textContent).toContain('3 files');
    await user.click(within(alert).getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(steps(running)).toEqual([
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: true,
        force: false,
        skipTeardown: false,
      },
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: true,
        force: true,
        skipTeardown: false,
      },
      { name: 'session.remove', entryId: WORKTREE_ENTRY },
    ]);
  });

  it('a failed teardown: hint before, exit code after, "Delete anyway" skips it', async () => {
    const running = await start({
      runState: 'sleeping',
      projects: { 'D:\\work\\sample': sampleProjectSettings({ teardown: 'docker compose down' }) },
      removeErrors: [makeError('GIT_FAILED', { op: 'teardown', exitCode: 3 })],
    });
    const user = userEvent.setup();
    const dialog = await openDialog();
    expect(dialog.querySelector('[data-slot="cleanup-teardown"]')).not.toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.dataset.reason).toBe('teardown');
    expect(alert.textContent).toContain('The teardown command failed (exit code 3).');
    expect(within(alert).getByRole('button', { name: 'Show output' })).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(steps(running).filter((cmd) => cmd.name === 'worktree.remove')).toEqual([
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: true,
        force: false,
        skipTeardown: false,
      },
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: true,
        force: false,
        skipTeardown: true,
      },
    ]);
  });

  it('a failed check and a failed session step show in the dialog; the retry repeats only the session step', async () => {
    const running = await start({
      runState: 'sleeping',
      inspection: makeError('GIT_FAILED', { op: 'status', detail: 'fatal: not a git repository' }),
      archiveError: makeError('SESSION_BUSY'),
    });
    const user = userEvent.setup();
    const dialog = await openDialog();
    expect(dialog.querySelector('[data-slot="cleanup-check-failed"]')?.textContent).toContain(
      'The worktree could not be checked.',
    );
    // Unknown state: keep by default; deleting needs no check box (the server checks again).
    expect(option(dialog, 'Keep the worktree').getAttribute('aria-checked')).toBe('true');
    await user.click(option(dialog, 'Delete the worktree, keep the branch'));
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(dialog.querySelector('[data-slot="cleanup-error"]')?.textContent).toContain(
        'The session is busy.',
      );
    });
    expect(dialog.querySelector('[data-slot="cleanup-worktree-gone"]')).not.toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(steps(running)).toEqual([
      {
        name: 'worktree.remove',
        entryId: WORKTREE_ENTRY,
        deleteBranch: false,
        force: false,
        skipTeardown: false,
      },
      { name: 'session.setArchived', entryId: WORKTREE_ENTRY, archived: true },
      { name: 'session.setArchived', entryId: WORKTREE_ENTRY, archived: true },
    ]);
  });

  it('Cancel changes nothing', async () => {
    const running = await start();
    const user = userEvent.setup();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(steps(running)).toEqual([]);
  });
});
