import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, STANDARD_PROFILE_ID } from '@shared/common';
import { STORAGE_KEYS, readStorage } from '@web/lib/storage';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { getSelectedSession, setSelectedSession } from '@web/state/selection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { DEMO_HOSTS, DEMO_SHARED_FOLDER, startHostsDemo, type RunningHostsDemo } from './hosts/hosts-demo';
import { NewSessionForm } from './NewSessionForm';

/**
 * WP-80 (WP-75 §4.4): "New session" with other computers – the computer comes first (last used
 * pre-selected), the folder browser, profiles and recent folders come from it, a switch clears a
 * folder of the other computer and the new session belongs to the chosen computer.
 */

vi.setConfig({ testTimeout: 60_000 });

let demo: RunningHostsDemo | null = null;
let single: RunningScenario | null = null;

afterEach(() => {
  demo?.stop();
  demo = null;
  single?.stop();
  single = null;
  resetClientStore();
  window.localStorage.clear();
  act(() => {
    setSelectedSession(null, { updateHash: false });
  });
});

function hostTrigger(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>('[data-slot="host-select"]');
  if (trigger === null) throw new Error('host select missing');
  return trigger;
}

function recentFolders(form: HTMLElement): string[] {
  const list = within(form).queryByRole('list', { name: 'Recent projects' });
  if (list === null) return [];
  return within(list)
    .getAllByRole('button')
    .map((button) => button.getAttribute('data-recent-project') ?? '');
}

async function startForm(props: Parameters<typeof NewSessionForm>[0] = {}): Promise<HTMLElement> {
  demo = startHostsDemo({ select: null });
  const running = demo;
  await waitFor(() => {
    expect(running.scenario.connection.status()).toBe('open');
  });
  render(
    <TooltipProvider>
      <NewSessionForm {...props} />
    </TooltipProvider>,
  );
  const form = await screen.findByRole('form', { name: 'New session' });
  await waitFor(() => {
    expect(
      document.querySelector('[data-slot="profile-select"]')?.getAttribute('data-profile-id'),
    ).not.toBeNull();
  });
  return form;
}

async function chooseHost(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(hostTrigger());
  await user.click(await screen.findByRole('menuitem', { name }));
}

describe('NewSessionForm with other computers', () => {
  it('without other computers there is no computer choice', async () => {
    single = startScenario('navigation', { select: null });
    render(
      <TooltipProvider>
        <NewSessionForm />
      </TooltipProvider>,
    );
    await screen.findByRole('form', { name: 'New session' });
    expect(document.querySelector('[data-slot="new-session-host"]')).toBeNull();
  });

  it('starts on this computer, offers every computer and lists the recent folders of the chosen one', async () => {
    const form = await startForm();
    expect(hostTrigger().dataset.hostId).toBe(LOCAL_HOST_ID);
    expect(within(form).getByText('Computer')).toBeTruthy();
    expect(recentFolders(form)).not.toContain('C:\\build\\pipeline');
    await chooseHost('Computer B');
    expect(hostTrigger().dataset.hostId).toBe(DEMO_HOSTS.b);
    await waitFor(() => {
      expect(recentFolders(form)).toEqual(['C:\\build\\pipeline', DEMO_SHARED_FOLDER]);
    });
  });

  it('creates the session on the chosen computer, selects it and remembers the computer', async () => {
    const form = await startForm();
    const running = demo;
    if (running === null) throw new Error('demo missing');
    await chooseHost('Computer C');
    const user = userEvent.setup();
    await user.type(within(form).getByRole('textbox', { name: 'Project folder' }), 'E:\\lab\\new');
    await user.click(within(form).getByRole('button', { name: 'Create session' }));
    const remote = running.computers.get(DEMO_HOSTS.c);
    await waitFor(() => {
      expect(remote.commands.filter((cmd) => cmd.name === 'session.create')).toEqual([
        { name: 'session.create', cwd: 'E:\\lab\\new', profileId: STANDARD_PROFILE_ID },
      ]);
    });
    expect(running.scenario.host.commands.some((cmd) => cmd.name === 'session.create')).toBe(false);
    const created = getSelectedSession();
    expect(created?.startsWith(`${DEMO_HOSTS.c}:`)).toBe(true);
    expect(readStorage('local', STORAGE_KEYS.newSessionHost)).toBe(DEMO_HOSTS.c);
  });

  it('pre-selects the last used computer, a pre-filled one wins', async () => {
    window.localStorage.setItem(STORAGE_KEYS.newSessionHost, DEMO_HOSTS.c);
    await startForm();
    expect(hostTrigger().dataset.hostId).toBe(DEMO_HOSTS.c);
    demo?.stop();
    demo = null;
    document.body.innerHTML = '';
    await startForm({ initialHostId: DEMO_HOSTS.b, initialCwd: DEMO_SHARED_FOLDER });
    expect(hostTrigger().dataset.hostId).toBe(DEMO_HOSTS.b);
  });

  it('a removed computer is never pre-selected', async () => {
    window.localStorage.setItem(STORAGE_KEYS.newSessionHost, 'computer-gone');
    await startForm();
    expect(hostTrigger().dataset.hostId).toBe(LOCAL_HOST_ID);
  });

  it('switching the computer clears a folder of the other one, keeps one typed for the new one', async () => {
    const form = await startForm({ initialCwd: 'D:\\work\\web\\landing' });
    const field = within(form).getByRole<HTMLInputElement>('textbox', { name: 'Project folder' });
    expect(field.value).toBe('D:\\work\\web\\landing');
    await chooseHost('Computer B');
    expect(field.value).toBe('');
    const user = userEvent.setup();
    await user.type(field, 'C:\\build');
    await chooseHost('Computer B');
    expect(field.value).toBe('C:\\build');
  });

  it('the folder browser asks the chosen computer', async () => {
    const form = await startForm();
    const running = demo;
    if (running === null) throw new Error('demo missing');
    await chooseHost('Computer B');
    const user = userEvent.setup();
    await user.click(within(form).getByRole('button', { name: 'Browse…' }));
    await screen.findByRole('dialog', { name: 'Choose a folder' });
    await waitFor(() => {
      expect(
        running.computers.get(DEMO_HOSTS.b).commands.some((cmd) => cmd.name === 'fs.listDirectory'),
      ).toBe(true);
    });
    expect(running.scenario.host.commands.some((cmd) => cmd.name === 'fs.listDirectory')).toBe(false);
  });

  it('an unreachable computer shows its status and cannot create sessions', async () => {
    const form = await startForm({ initialHostId: DEMO_HOSTS.b });
    const running = demo;
    if (running === null) throw new Error('demo missing');
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.b, false);
    });
    await waitFor(() => {
      expect(hostTrigger().textContent).toContain('Not reachable');
    });
    const user = userEvent.setup();
    await user.type(within(form).getByRole('textbox', { name: 'Project folder' }), 'C:\\build');
    expect(within(form).getByRole('button', { name: 'Create session' })).toHaveProperty('disabled', true);
  });
});
