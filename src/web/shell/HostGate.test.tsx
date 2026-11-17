import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import { clientStore, resetClientStore, updateHost, type HostRecord } from '@web/state/store';
import { HostGate } from './HostGate';

afterEach(() => {
  resetClientStore();
});

function renderGate(record: Partial<HostRecord>) {
  updateHost(clientStore, LOCAL_HOST_ID, () => record);
  return render(
    <HostGate>
      <p>shell content</p>
    </HostGate>,
  );
}

describe('HostGate: restart for an update (close 4504, WP-88b)', () => {
  it('restarting before the first hello takes the page (spinner, no shell)', () => {
    renderGate({ phase: 'restarting', status: 'reconnecting', everConnected: false, restartDeadline: 1 });
    expect(screen.getByRole('heading', { name: 'Parallax is restarting…' })).toBeTruthy();
    expect(screen.getByText('Switching versions. This window reconnects by itself.')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Parallax is restarting…' })).toBeTruthy();
    expect(screen.queryByText('shell content')).toBeNull();
  });

  it('restarting after a hello keeps the shell (ShellBanners shows the restart)', () => {
    renderGate({ phase: 'restarting', status: 'reconnecting', everConnected: true, restartDeadline: 1 });
    expect(screen.getByText('shell content')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('after the deadline: "server stopped" with the error text and "Reconnect"', () => {
    renderGate({
      phase: 'server-stopped',
      status: 'closed',
      everConnected: true,
      error: makeError('UPDATE_RESTART_FAILED', { reason: 'timeout' }),
    });
    expect(screen.getByRole('heading', { name: 'Parallax server stopped' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Switching to the new version failed.');
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.queryByText('shell content')).toBeNull();
  });

  it('close 4503 stays as it was: "server stopped" without an error text', () => {
    renderGate({
      phase: 'server-stopped',
      status: 'closed',
      everConnected: true,
      error: makeError('SERVER_SHUTTING_DOWN'),
    });
    expect(screen.getByRole('heading', { name: 'Parallax server stopped' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
