import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import { sampleSummary } from '@shared/samples';
import { NAVIGATION_SESSION_KEYS } from '@web/playground/navigation-scenario';
import { ClientCommandError } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { resetClientStore } from '@web/state/store';
import { AppShell } from '../AppShell';
import { closeNewSession } from '../NewSessionDialog';
import { registerShellRequestHandler } from '../requests';
import { resetRename } from '../navigation/rename';
import { HEADER_ACTIONS, SIDEBAR_ACTIONS, sessionActions } from '../navigation/session-actions';
import { resetSidebarView } from '../navigation/sidebar-view';
import { DEMO_HOST_KEYS, DEMO_HOSTS, startHostsDemo, type RunningHostsDemo } from './hosts-demo';

/**
 * WP-80 (WP-75 §4.4, ADR-208): sessions of another computer – no editor, Explorer, console or
 * sign-in (left out of the menus and refused before sending), the header names the computer, and
 * a banner explains an unavailable computer.
 */

vi.setConfig({ testTimeout: 60_000 });

let demo: RunningHostsDemo | null = null;
const cleanups: (() => void)[] = [];

afterEach(() => {
  act(() => {
    closeNewSession();
    resetRename();
  });
  demo?.stop();
  demo = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetClientStore();
  window.localStorage.clear();
  window.sessionStorage.clear();
  act(() => {
    resetSidebarView();
  });
  window.history.replaceState(null, '', '/');
});

function ids(sessionKey: string, slots = SIDEBAR_ACTIONS): string[] {
  const summary = sampleSummary({
    entryId: parseSessionKey(sessionKey)?.entryId,
    sessionId: 'a1b2c3d4-0000-4000-8000-000000000001',
    remoteControl: {
      wanted: true,
      state: 'failed',
      sessionUrl: null,
      error: makeError('REMOTE_CONTROL_AUTH'),
    },
  });
  return sessionActions(slots, sessionKey, summary, 'sidebar').flatMap((action) =>
    action === null ? [] : [action.id],
  );
}

async function startWith(select: string): Promise<RunningHostsDemo> {
  demo = startHostsDemo({ select });
  render(<AppShell />);
  await within(await screen.findByRole('navigation', { name: 'Sessions' })).findByText('Build pipeline');
  return demo;
}

function header(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="session-header"]');
  if (element === null) throw new Error('header missing');
  return element;
}

describe('actions of a shared session', () => {
  it('leaves out Explorer, shell (WP-97), external console, console command and sign-in; keeps the rest', () => {
    const local = ids(NAVIGATION_SESSION_KEYS.auth);
    const shared = ids(DEMO_HOST_KEYS.pipeline);
    const onlyLocal = ['openFolder', 'openShell', 'openExternal', 'copyConsoleCommand', 'signIn'];
    for (const id of onlyLocal) {
      expect(local, id).toContain(id);
      expect(shared, id).not.toContain(id);
    }
    expect(shared).toEqual(local.filter((id) => !onlyLocal.includes(id)));
    expect(ids(DEMO_HOST_KEYS.pipeline, HEADER_ACTIONS)).not.toContain('openFolder');
    expect(ids(DEMO_HOST_KEYS.pipeline, HEADER_ACTIONS)).not.toContain('openShell');
  });

  it('refuses commands the other computer would refuse before sending them', async () => {
    const running = await startWith(NAVIGATION_SESSION_KEYS.auth);
    const remote = running.computers.get(DEMO_HOSTS.b);
    const entryId = parseSessionKey(DEMO_HOST_KEYS.pipeline)?.entryId ?? '';
    const refused = sendCommand(DEMO_HOST_KEYS.pipeline, {
      name: 'file.open',
      entryId,
      path: 'C:\\build\\pipeline',
      target: 'explorer',
      line: null,
      col: null,
    });
    await expect(refused).rejects.toBeInstanceOf(ClientCommandError);
    await expect(refused).rejects.toMatchObject({ error: { code: 'REMOTE_NOT_ALLOWED' } });
    expect(remote.commands.some((cmd) => cmd.name === 'file.open')).toBe(false);
    // Allowed commands go to the session's computer.
    await sendCommand(DEMO_HOST_KEYS.pipeline, { name: 'session.setPinned', entryId, pinned: true });
    expect(remote.commands).toContainEqual({ name: 'session.setPinned', entryId, pinned: true });
  });
});

describe('header and banner', () => {
  it('the header names the computer of a shared session, not of a local one', async () => {
    await startWith(DEMO_HOST_KEYS.pipeline);
    await waitFor(() => {
      expect(header().textContent).toContain('Build pipeline');
    });
    const host = document.querySelector<HTMLElement>('[data-slot="header-host"]');
    expect(host?.textContent).toContain('Computer B');
    expect(host?.querySelector('[data-slot="host-badge"]')?.getAttribute('data-host-color')).toBe('teal');
    expect(document.querySelector('[data-slot="pane-host"]')).toBeNull();
    // WP-97: no shell button – a shell would open on the other computer's desktop.
    expect(document.querySelector('[data-slot="console-button"]')).toBeNull();
  });

  it('a local session has no computer in the header, but the shell button (WP-97)', async () => {
    await startWith(NAVIGATION_SESSION_KEYS.auth);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="session-header"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-slot="header-host"]')).toBeNull();
    expect(document.querySelector('[data-slot="console-button"]')).not.toBeNull();
  });

  it('unreachable: banner with "Reconnect" (hosts.reconnect on this computer)', async () => {
    const running = await startWith(DEMO_HOST_KEYS.pipeline);
    act(() => {
      running.computers.setReachable(DEMO_HOSTS.b, false);
    });
    const banner = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-slot="pane-host"]');
      if (found === null) throw new Error('banner missing');
      return found;
    });
    expect(banner.dataset.availability).toBe('unreachable');
    expect(banner.textContent).toContain('Computer B is not reachable.');
    await userEvent.setup().click(within(banner).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => {
      expect(running.scenario.host.commands).toContainEqual({
        name: 'hosts.reconnect',
        hostId: DEMO_HOSTS.b,
      });
    });
  });

  it('incompatible: both versions, no reconnect loop; revoked: only the settings', async () => {
    const running = await startWith(DEMO_HOST_KEYS.pipeline);
    act(() => {
      running.computers.makeIncompatible(DEMO_HOSTS.b, '9.9.9');
    });
    const banner = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-slot="pane-host"][data-availability="incompatible"]',
      );
      if (found === null) throw new Error('banner missing');
      return found;
    });
    expect(banner.textContent).toMatch(
      /Parallax on Computer B has another version \(9\.9\.9\)\. Update Parallax on Computer B to .+\./,
    );
    act(() => {
      running.computers.revoke(DEMO_HOSTS.b);
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="pane-host"]')?.getAttribute('data-availability')).toBe(
        'revoked',
      );
    });
    const revoked = document.querySelector<HTMLElement>('[data-slot="pane-host"]');
    if (revoked === null) throw new Error('banner missing');
    expect(within(revoked).queryByRole('button', { name: 'Reconnect' })).toBeNull();
    const requests: unknown[] = [];
    cleanups.push(
      registerShellRequestHandler('settings', (request) => {
        requests.push(request);
        return true;
      }),
    );
    await userEvent.setup().click(within(revoked).getByRole('button', { name: 'Several computers…' }));
    expect(requests).toContainEqual({ kind: 'settings', section: 'multiHost' });
  });
});
