import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_PROFILE_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import type { ProjectSettingsMap } from '@shared/model';
import type { Command } from '@shared/protocol';
import {
  sampleGitWorktree,
  sampleHostState,
  sampleId,
  sampleProfileSummary,
  sampleProjectSettings,
  sampleSettings,
  sampleSummary,
} from '@shared/samples';
import type { FakeAck } from '@web/state/fake-host';
import { setSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { EmptyState } from './EmptyState';
import { startNewSessionDemo, type NewSessionDemo } from './new-session/demo-host';
import { NewSessionForm, chosenProfile } from './NewSessionForm';

// Form + menus: a few seconds in a full `pnpm test`, more under parallel load (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

const WORK = sampleId('pf', 2);
const GONE = sampleId('pf', 9);

const PROFILES = [
  sampleProfileSummary(),
  sampleProfileSummary({ id: WORK, name: 'Work', color: 'blue', isDefault: false, builtin: false }),
];

let demo: NewSessionDemo | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  resetClientStore();
  act(() => {
    setSelectedSession(null, { updateHash: false });
  });
});

function profileTrigger(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('[data-slot="profile-select"]');
  if (trigger === null) throw new Error('profile select missing');
  return trigger;
}

async function startHost(summaryCount = 0): Promise<NewSessionDemo> {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  demo = startNewSessionDemo({
    immediate: true,
    hostState: sampleHostState({ profiles: PROFILES, defaultProfileId: WORK }),
    summaries: Array.from({ length: summaryCount }, (_, n) =>
      sampleSummary({
        entryId: sampleId('en', n + 1),
        cwd: `D:\\work\\p${String(n)}`,
        lastActivityAt: at(n),
        archived: n % 3 === 0,
      }),
    ),
  });
  const running = demo;
  await waitFor(() => {
    expect(running.connection.status()).toBe('open');
  });
  return running;
}

describe('chosenProfile', () => {
  it('takes the choice if it exists, else the default, else the first profile', () => {
    expect(chosenProfile(PROFILES, WORK, STANDARD_PROFILE_ID)?.id).toBe(WORK);
    expect(chosenProfile(PROFILES, GONE, WORK)?.id).toBe(WORK);
    expect(chosenProfile(PROFILES, null, STANDARD_PROFILE_ID)?.id).toBe(STANDARD_PROFILE_ID);
    expect(chosenProfile(PROFILES, null, GONE)?.id).toBe(STANDARD_PROFILE_ID);
    expect(chosenProfile([], null, null)).toBeNull();
  });
});

describe('NewSessionForm (inline, empty state)', () => {
  it('cannot create a session before the host sent its profiles', () => {
    render(
      <TooltipProvider>
        <NewSessionForm initialCwd="D:\work" />
      </TooltipProvider>,
    );
    expect(screen.getByText('No profile available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create session' })).toHaveProperty('disabled', true);
  });

  it('shows the host default profile and at most eight recent projects (archived included)', async () => {
    const running = await startHost(10);
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <EmptyState />
      </TooltipProvider>,
    );
    const form = await screen.findByRole('form', { name: 'New session' });
    await waitFor(() => {
      expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    });
    const recent = within(form).getByRole('list', { name: 'Recent projects' });
    const folders = within(recent)
      .getAllByRole('button')
      .map((button) => button.getAttribute('data-recent-project'));
    // p0 (archived) is the newest; p8 and p9 are beyond the eight.
    expect(folders).toEqual(Array.from({ length: 8 }, (_, n) => `D:\\work\\p${String(n)}`));
    await user.click(within(recent).getByRole('button', { name: /p3$/ }));
    await user.click(within(form).getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([
        { name: 'session.create', cwd: 'D:\\work\\p3', profileId: WORK },
      ]);
    });
  });

  it('falls back to the default profile when the pre-selected one is gone', async () => {
    const running = await startHost();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <NewSessionForm initialCwd="D:\work" initialProfileId={GONE} />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    });
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([{ name: 'session.create', cwd: 'D:\\work', profileId: WORK }]);
    });
  });
});

describe('NewSessionForm: own worktree (WP-114, ADR-250)', () => {
  const REPO = 'D:\\work\\sample';
  const LINKED = 'D:\\work\\sample\\.claude\\worktrees\\feature-a';

  async function startGitHost(
    options: {
      projects?: ProjectSettingsMap;
      git?: boolean;
      onCommand?: (cmd: Command) => FakeAck | undefined;
    } = {},
  ): Promise<NewSessionDemo> {
    demo = startNewSessionDemo({
      immediate: true,
      hostState: sampleHostState({
        profiles: PROFILES,
        defaultProfileId: WORK,
        features: { git: options.git ?? true, search: false, overview: false },
        settings: sampleSettings({ projects: options.projects ?? {} }),
      }),
      onCommand: (cmd) => {
        const own = options.onCommand?.(cmd);
        if (own !== undefined) return own;
        if (cmd.name !== 'worktree.list') return undefined;
        return {
          ok: true,
          result: {
            repoRoot: REPO,
            worktrees: [sampleGitWorktree(), sampleGitWorktree({ path: LINKED, branch: 'feature/a', main: false })],
          },
        };
      },
    });
    const running = demo;
    await waitFor(() => {
      expect(running.connection.status()).toBe('open');
    });
    return running;
  }

  function renderForm(cwd = 'D:\\work\\sample\\src') {
    render(
      <TooltipProvider>
        <NewSessionForm initialCwd={cwd} />
      </TooltipProvider>,
    );
  }

  it('without the git service of the host: no switch and no git question', async () => {
    const running = await startGitHost({ git: false });
    const user = userEvent.setup();
    renderForm();
    await waitFor(() => {
      expect(profileTrigger().getAttribute('data-profile-id')).toBe(WORK);
    });
    expect(screen.queryByRole('switch', { name: 'In its own worktree' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toHaveLength(1);
    });
    expect(running.commands('worktree.list')).toEqual([]);
    expect(running.commands('session.create')[0]?.worktree).toBeUndefined();
  });

  it('in a repository the switch shows (off); switched on, a new branch from the main branch goes along', async () => {
    const running = await startGitHost();
    const user = userEvent.setup();
    renderForm();
    const toggle = await screen.findByRole('switch', { name: 'In its own worktree' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(running.commands('worktree.list')).toEqual([{ name: 'worktree.list', cwd: 'D:\\work\\sample\\src' }]);
    await user.click(toggle);
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch name' });
    expect(branch.value).toMatch(/^parallax\/[a-z0-9]{6}$/);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Based on' }).value).toBe('main');
    await user.clear(branch);
    await user.type(branch, 'feature/login');
    expect(document.querySelector('[data-slot="worktree-folder"]')?.textContent).toContain('feature-login');
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')).toEqual([
        {
          name: 'session.create',
          cwd: 'D:\\work\\sample\\src',
          profileId: WORK,
          worktree: { mode: 'new', branch: 'feature/login', baseRef: 'main' },
        },
      ]);
    });
  });

  it('the project default switches it on; an invalid branch name blocks "Create" with a reason', async () => {
    await startGitHost({ projects: { [REPO]: sampleProjectSettings({ worktreeDefault: true }) } });
    const user = userEvent.setup();
    renderForm();
    const toggle = await screen.findByRole('switch', { name: 'In its own worktree' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const branch = screen.getByRole<HTMLInputElement>('textbox', { name: 'Branch name' });
    await user.clear(branch);
    await user.type(branch, 'bad name');
    expect(screen.getByRole('alert').textContent).toContain('Not a valid branch name');
    expect(screen.getByRole('button', { name: 'Create session' })).toHaveProperty('disabled', true);
    await user.clear(branch);
    expect(screen.getByRole('alert').textContent).toContain('Enter a name for the new branch.');
  });

  it('an existing worktree (not the main one) can be picked instead', async () => {
    const running = await startGitHost();
    const user = userEvent.setup();
    renderForm(REPO);
    await user.click(await screen.findByRole('switch', { name: 'In its own worktree' }));
    await user.click(screen.getByRole('radio', { name: 'Existing worktree' }));
    expect(screen.getByRole('button', { name: 'Create session' })).toHaveProperty('disabled', true);
    const options = within(screen.getByRole('radiogroup', { name: 'Worktree' })).getAllByRole('radio');
    expect(options).toHaveLength(1);
    await user.click(screen.getByRole('radio', { name: /feature\/a/ }));
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(running.commands('session.create')[0]?.worktree).toEqual({ mode: 'existing', path: LINKED });
    });
  });

  it('outside a repository nothing shows; a git refusal shows in the form with its detail', async () => {
    const running = await startGitHost({
      onCommand: (cmd) => {
        if (cmd.name === 'worktree.list' && cmd.cwd === 'D:\\elsewhere') {
          return { ok: false, error: makeError('NOT_A_GIT_REPO', { path: cmd.cwd }) };
        }
        if (cmd.name === 'session.create') {
          return { ok: false, error: makeError('BRANCH_EXISTS', { branch: 'feature/login' }) };
        }
        return undefined;
      },
    });
    const user = userEvent.setup();
    renderForm('D:\\elsewhere');
    await waitFor(() => {
      expect(running.commands('worktree.list')).toHaveLength(1);
    });
    expect(screen.queryByRole('switch', { name: 'In its own worktree' })).toBeNull();
    const field = screen.getByLabelText('Project folder');
    await user.clear(field);
    await user.type(field, REPO);
    await user.click(await screen.findByRole('switch', { name: 'In its own worktree' }));
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('A branch with this name already exists.');
    expect(alert.querySelector('[data-slot="error-detail"]')?.textContent).toBe('feature/login');
    expect(screen.getByRole('textbox', { name: 'Branch name' }).getAttribute('aria-invalid')).toBe('true');
  });
});
