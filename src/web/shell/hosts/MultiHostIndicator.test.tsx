import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { sampleRemoteAccessState, sampleRemotePeer } from '@shared/samples';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { registerShellRequestHandler } from '../requests';
import { DEMO_HOSTS, startHostsDemo, type RunningHostsDemo } from './hosts-demo';
import { MultiHostIndicator } from './MultiHostIndicator';

vi.setConfig({ testTimeout: 30_000 });

let single: RunningScenario | null = null;
let demo: RunningHostsDemo | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  single?.stop();
  single = null;
  demo?.stop();
  demo = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
});

function indicator(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="multi-host-indicator"]');
}

async function startSharing(access: Parameters<typeof sampleRemoteAccessState>[0]): Promise<RunningScenario> {
  single = startScenario('empty', { select: null });
  const running = single;
  act(() => {
    running.host.setHostState({
      ...running.host.hostState,
      multiHost: { ...running.host.hostState.multiHost, role: 'share' },
      remoteAccess: sampleRemoteAccessState(access),
    });
  });
  render(
    <TooltipProvider>
      <MultiHostIndicator />
    </TooltipProvider>,
  );
  await waitFor(() => {
    expect(indicator()).not.toBeNull();
  });
  return running;
}

describe('MultiHostIndicator (WP-80)', () => {
  it('is invisible without a role', async () => {
    single = startScenario('empty', { select: null });
    const running = single;
    render(
      <TooltipProvider>
        <MultiHostIndicator />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(running.connection.status()).toBe('open');
    });
    expect(indicator()).toBeNull();
  });

  it('sharing: listener, connected controlling computer, unseen rejected attempts; click opens the settings', async () => {
    const running = await startSharing({ unseenRejected: 0 });
    expect(indicator()?.getAttribute('aria-label')).toBe(
      'Sharing: waiting for connections · Several computers – open settings',
    );
    expect(indicator()?.dataset.role).toBe('share');
    act(() => {
      running.host.setHostState({
        ...running.host.hostState,
        remoteAccess: sampleRemoteAccessState({ peer: sampleRemotePeer(), unseenRejected: 12 }),
      });
    });
    await waitFor(() => {
      expect(indicator()?.getAttribute('aria-label')).toBe(
        'Sharing: Computer A is connected · 12 rejected attempts · Several computers – open settings',
      );
    });
    expect(indicator()?.dataset.tone).toBe('ok');
    expect(document.querySelector('[data-slot="multi-host-rejected"]')?.textContent).toBe('9+');
    const requests: unknown[] = [];
    cleanups.push(
      registerShellRequestHandler('settings', (request) => {
        requests.push(request);
        return true;
      }),
    );
    const button = indicator();
    if (button === null) throw new Error('indicator missing');
    await userEvent.setup().click(button);
    expect(requests).toEqual([{ kind: 'settings', section: 'multiHost' }]);
  });

  it('sharing: a failed listener is a warning', async () => {
    await startSharing({
      listening: false,
      error: makeError('REMOTE_ACCESS_FAILED', { reason: 'port_in_use' }),
    });
    expect(indicator()?.dataset.tone).toBe('warn');
    expect(indicator()?.getAttribute('aria-label')).toContain('Sharing: listener failed');
  });

  it('controlling: how many computers are connected', async () => {
    demo = startHostsDemo({ select: null });
    const running = demo;
    render(
      <TooltipProvider>
        <MultiHostIndicator />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(indicator()?.getAttribute('aria-label')).toContain('2 computers connected');
    });
    expect(indicator()?.dataset.role).toBe('control');
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.c, false);
    });
    await waitFor(() => {
      expect(indicator()?.getAttribute('aria-label')).toContain('1 of 2 computers connected');
    });
    expect(indicator()?.dataset.tone).toBe('warn');
  });
});
