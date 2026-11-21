import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, makeSessionKey, type TerminalId } from '@shared/common';
import type { WorktreeSetup } from '@shared/model';
import { sampleHostState, sampleId, sampleSummary, sampleWorktreeRef } from '@shared/samples';
import { startNewSessionDemo, type NewSessionDemo } from '@web/shell/new-session/demo-host';
import { registerShellRequestHandler } from '@web/shell/requests';
import { resetClientStore } from '@web/state/store';
import { WORKTREE_SLOTS } from './index';
import { WorktreeNotice } from './WorktreeNotice';

/** WP-114: the slot `WorktreeNotice` – creating, setup running, setup failed, creation failed. */

vi.setConfig({ testTimeout: 60_000 });

const ENTRY = sampleId('en', 2);
const KEY = makeSessionKey(LOCAL_HOST_ID, ENTRY);
const TERMINAL: TerminalId = `tm_${'5'.repeat(32)}`;

let demo: NewSessionDemo | null = null;
let removeHandler: (() => void) | null = null;

afterEach(() => {
  removeHandler?.();
  removeHandler = null;
  demo?.stop();
  demo = null;
  resetClientStore();
});

async function start(setup: WorktreeSetup | null, portBase: number | null = 41000): Promise<NewSessionDemo> {
  demo = startNewSessionDemo({
    immediate: true,
    hostState: sampleHostState({
      terminalAvailable: true,
      features: { git: true, search: false, overview: false },
    }),
    summaries: [
      sampleSummary({
        entryId: ENTRY,
        cwd: sampleWorktreeRef().path,
        worktree: sampleWorktreeRef({ portBase }),
        worktreeSetup: setup,
      }),
    ],
  });
  const running = demo;
  await waitFor(() => {
    expect(running.connection.status()).toBe('open');
  });
  return running;
}

function notice(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="worktree-notice"]');
}

describe('WorktreeNotice (WP-114)', () => {
  it('while the worktree is created: the state with branch and port block, no buttons', async () => {
    await start({ state: 'creating', exitCode: null, terminalId: null });
    render(<WorktreeNotice sessionKey={KEY} />);
    await waitFor(() => {
      expect(notice()?.dataset.state).toBe('creating');
    });
    expect(notice()?.textContent).toContain('Creating the worktree…');
    expect(notice()?.querySelector('[data-slot="worktree-identity"]')?.textContent).toBe(
      'Worktree feature/login·ports 41000–41009',
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('setup running: "Show output" opens the side panel at the terminal tab', async () => {
    await start({ state: 'setup', exitCode: null, terminalId: TERMINAL }, null);
    const panels: unknown[] = [];
    removeHandler = registerShellRequestHandler('sidePanel', (request) => {
      panels.push(request);
      return true;
    });
    const user = userEvent.setup();
    render(<WorktreeNotice sessionKey={KEY} />);
    await waitFor(() => {
      expect(notice()?.dataset.state).toBe('setup');
    });
    expect(notice()?.textContent).toContain('Your first message can go once it is done.');
    expect(notice()?.textContent).not.toContain('ports');
    await user.click(screen.getByRole('button', { name: 'Show output' }));
    expect(panels).toEqual([{ kind: 'sidePanel', sessionKey: KEY, tab: 'terminal' }]);
  });

  it('setup failed: exit code, "Start anyway" resumes the session; it goes once the state is gone', async () => {
    const running = await start({ state: 'failed', exitCode: 2, terminalId: TERMINAL });
    const user = userEvent.setup();
    render(<WorktreeNotice sessionKey={KEY} />);
    await waitFor(() => {
      expect(notice()?.dataset.state).toBe('failed');
    });
    expect(notice()?.getAttribute('role')).toBe('status');
    expect(notice()?.textContent).toContain('The setup command failed (exit code 2).');
    expect(screen.getByRole('button', { name: 'Show output' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start anyway' }));
    await waitFor(() => {
      expect(running.commands('session.resume')).toEqual([{ name: 'session.resume', entryId: ENTRY }]);
    });
    act(() => {
      running.host.patchSummary(ENTRY, { worktreeSetup: null });
    });
    await waitFor(() => {
      expect(notice()).toBeNull();
    });
  });

  it('a stopped setup and a failed `git worktree add` read differently', async () => {
    const running = await start({ state: 'failed', exitCode: null, terminalId: TERMINAL });
    render(<WorktreeNotice sessionKey={KEY} />);
    await waitFor(() => {
      expect(notice()?.textContent).toContain('The setup command was stopped.');
    });
    act(() => {
      running.host.patchSummary(ENTRY, {
        worktreeSetup: { state: 'failed', exitCode: null, terminalId: null },
      });
    });
    await waitFor(() => {
      expect(notice()?.dataset.state).toBe('create-failed');
    });
    expect(notice()?.getAttribute('role')).toBe('alert');
    expect(notice()?.textContent).toContain('The worktree could not be created.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('the slot renders nothing (and loads no chunk) without a setup state', async () => {
    const running = await start(null);
    const { WorktreeNotice: Slot } = WORKTREE_SLOTS;
    render(<Slot sessionKey={KEY} />);
    expect(notice()).toBeNull();
    act(() => {
      running.host.patchSummary(ENTRY, {
        worktreeSetup: { state: 'creating', exitCode: null, terminalId: null },
      });
    });
    await waitFor(() => {
      expect(notice()?.dataset.state).toBe('creating');
    });
  });
});
