import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { DEFAULT_PROJECT_SETTINGS, type HostFeatures, type ProjectSettingsMap } from '@shared/model';
import { WIN32_PATHS } from '@shared/paths';
import {
  sampleHostState,
  sampleId,
  sampleProjectSettings,
  sampleSettings,
  sampleSummary,
  sampleWorktreeRef,
} from '@shared/samples';
import { startNewSessionDemo, type NewSessionDemo } from '@web/shell/new-session/demo-host';
import { useHostState } from '@web/state/hooks';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { useSettingsEditor } from '../state/settings-editor';
import { ProjectsSection, withProject } from './ProjectsSection';

/** WP-114 (ADR-250/251): settings section "Projects". */

vi.setConfig({ testTimeout: 60_000 });

const API = 'D:\\work\\api';
const SAMPLE = sampleWorktreeRef().repoRoot;
const TOOLS = 'D:\\work\\tools';
const STORED_API = sampleProjectSettings({ setup: 'npm ci', ports: false });
const GIT: HostFeatures = { git: true, search: false, overview: false };

let demo: NewSessionDemo | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  resetClientStore();
});

function Section() {
  const editor = useSettingsEditor();
  const hostState = useHostState();
  return <ProjectsSection editor={editor} hostState={hostState} />;
}

async function start(features: HostFeatures = GIT): Promise<NewSessionDemo> {
  demo = startNewSessionDemo({
    immediate: true,
    hostState: sampleHostState({ features, settings: sampleSettings({ projects: { [API]: STORED_API } }) }),
    summaries: [
      sampleSummary({
        entryId: sampleId('en', 1),
        cwd: sampleWorktreeRef().path,
        worktree: sampleWorktreeRef(),
      }),
      sampleSummary({ entryId: sampleId('en', 2), cwd: `${TOOLS}\\cli` }),
      sampleSummary({ entryId: sampleId('en', 3), cwd: 'D:\\notes' }),
      sampleSummary({ entryId: sampleId('en', 4), cwd: 'D:\\gone' }),
    ],
    onCommand: (cmd) => {
      if (cmd.name !== 'worktree.list') return undefined;
      if (cmd.cwd === `${TOOLS}\\cli`) return { ok: true, result: { repoRoot: TOOLS, worktrees: [] } };
      if (cmd.cwd === 'D:\\notes') return { ok: true, result: { repoRoot: null, worktrees: [] } };
      return { ok: false, error: makeError('NOT_A_GIT_REPO', { path: cmd.cwd }) };
    },
  });
  const running = demo;
  render(
    <TooltipProvider>
      <Section />
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(running.connection.status()).toBe('open');
  });
  return running;
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('li[data-project]')];
}

function row(root: string): HTMLElement {
  const found = rows().find((item) => item.dataset.project === root);
  if (found === undefined) throw new Error(`no row for ${root}`);
  return found;
}

async function expand(root: string): Promise<HTMLElement> {
  const item = row(root);
  const toggle = within(item).getAllByRole('button')[0];
  if (toggle === undefined) throw new Error('no toggle');
  await userEvent.setup().click(toggle);
  return item;
}

function savedProjects(running: NewSessionDemo): ProjectSettingsMap[] {
  return running
    .commands('settings.update')
    .flatMap((cmd) => (cmd.patch.projects === undefined ? [] : [cmd.patch.projects]));
}

describe('settings section "Projects" (WP-114)', () => {
  it('lists configured projects, worktree repositories and the repositories git finds for other session folders', async () => {
    const running = await start();
    await waitFor(() => {
      expect(rows().map((item) => item.dataset.project)).toEqual([API, SAMPLE, TOOLS]);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="projects-scanning"]')).toBeNull();
    });
    // The worktree session's folder lies in a known root: git is not asked for it.
    expect(
      running
        .commands('worktree.list')
        .map((cmd) => cmd.cwd)
        .sort(),
    ).toEqual(['D:\\gone', 'D:\\notes', `${TOOLS}\\cli`]);
    expect(within(row(API)).getByText('Setup')).toBeTruthy();
    expect(screen.getByText(/PARALLAX_WORKTREE_PORT/, { selector: 'p' })).toBeTruthy();
  });

  it('a switch saves the whole map at once, a command on blur, "Remove" drops the project', async () => {
    const running = await start();
    const user = userEvent.setup();
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    const sample = await expand(SAMPLE);
    expect(within(sample).queryByRole('button', { name: 'Remove the settings of this project' })).toBeNull();
    await user.click(
      within(sample).getByRole('switch', { name: 'Start new sessions in their own worktree' }),
    );
    const sampleSaved = { ...DEFAULT_PROJECT_SETTINGS, worktreeDefault: true };
    await waitFor(() => {
      expect(savedProjects(running)).toEqual([{ [API]: STORED_API, [SAMPLE]: sampleSaved }]);
    });

    const api = await expand(API);
    const setup = within(api).getByRole('textbox', { name: 'Setup command' });
    expect(setup.getAttribute('placeholder')).toBe('pnpm install --frozen-lockfile');
    await user.clear(setup);
    await user.type(setup, 'pnpm install');
    expect(savedProjects(running)).toHaveLength(1);
    await user.tab();
    await waitFor(() => {
      expect(savedProjects(running).at(-1)).toEqual({
        [API]: { ...STORED_API, setup: 'pnpm install' },
        [SAMPLE]: sampleSaved,
      });
    });

    await user.click(within(api).getByRole('button', { name: 'Remove the settings of this project' }));
    await waitFor(() => {
      expect(savedProjects(running).at(-1)).toEqual({ [SAMPLE]: sampleSaved });
    });
    // No session runs in that repository: without settings it leaves the list.
    await waitFor(() => {
      expect(rows().map((item) => item.dataset.project)).toEqual([SAMPLE, TOOLS]);
    });
  });

  it('without the git service of the host: only the hint, git is not asked', async () => {
    const running = await start({ git: false, search: false, overview: false });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="projects-unavailable"]')).not.toBeNull();
    });
    expect(rows()).toHaveLength(0);
    expect(running.commands('worktree.list')).toEqual([]);
  });
});

describe('withProject', () => {
  it('replaces the key in its stored spelling, drops a project back at the defaults', () => {
    const stored: ProjectSettingsMap = { 'D:\\Work\\Api': STORED_API, [TOOLS]: STORED_API };
    const next = sampleProjectSettings({ setup: '', ports: true });
    expect(withProject(stored, 'd:\\work\\api', next, WIN32_PATHS)).toEqual({
      'D:\\Work\\Api': next,
      [TOOLS]: STORED_API,
    });
    expect(withProject(stored, 'd:\\work\\api', { ...DEFAULT_PROJECT_SETTINGS }, WIN32_PATHS)).toEqual({
      [TOOLS]: STORED_API,
    });
    expect(withProject(stored, TOOLS, null, WIN32_PATHS)).toEqual({ 'D:\\Work\\Api': STORED_API });
    expect(withProject({}, SAMPLE, next, WIN32_PATHS)).toEqual({ [SAMPLE]: next });
  });
});
