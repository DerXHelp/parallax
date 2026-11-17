import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import type { UpdateState } from '@shared/model';
import { SAMPLE_UPDATE_STATES } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { registerShellRequestHandler, type ShellRequestOf } from '@web/shell/requests';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { startUpdatesHost, updateHostState, type UpdatesHost } from './testing';
import { UpdateNotice } from './UpdateNotice';

vi.setConfig({ testTimeout: 30_000 });

let running: UpdatesHost | null = null;
let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  running?.stop();
  running = null;
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
});

async function start(update: UpdateState): Promise<UpdatesHost> {
  const started = startUpdatesHost({ hostState: updateHostState(update) });
  running = started;
  await waitFor(() => {
    expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.hostState ?? null).not.toBeNull();
  });
  return started;
}

function renderNotice(compact = false) {
  return render(
    <TooltipProvider>
      <UpdateNotice compact={compact} />
    </TooltipProvider>,
  );
}

function captureSettingsRequests(): ShellRequestOf<'settings'>[] {
  const requests: ShellRequestOf<'settings'>[] = [];
  cleanups.push(
    registerShellRequestHandler('settings', (request) => {
      requests.push(request);
      return true;
    }),
  );
  return requests;
}

describe('UpdateNotice (head of the sidebar)', () => {
  it('"Parallax <v> available" opens the settings section "Updates"', async () => {
    await start(SAMPLE_UPDATE_STATES.available);
    const requests = captureSettingsRequests();
    const user = userEvent.setup();
    renderNotice();
    await user.click(await screen.findByRole('button', { name: 'Parallax 1.0.1 available' }));
    expect(requests).toEqual([{ kind: 'settings', section: 'updates' }]);
    expect(document.querySelector('[data-slot="update-notice"]')?.getAttribute('data-state')).toBe(
      'available',
    );
  });

  it('a prepared version says "ready – restart"', async () => {
    await start(SAMPLE_UPDATE_STATES.ready);
    renderNotice();
    expect(await screen.findByRole('button', { name: 'Parallax 1.0.1 ready – restart' })).toBeTruthy();
  });

  it('the cross hides the hint for this version (update.dismiss available)', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.available);
    const user = userEvent.setup();
    renderNotice();
    await user.click(await screen.findByRole('button', { name: 'Hide this update hint' }));
    expect(host.commands).toContainEqual({ name: 'update.dismiss', what: 'available' });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="update-notice"]')).toBeNull();
    });
    expect(host.hostState.update.dismissedVersion).toBe('1.0.1');
  });

  it.each([
    ['idle', SAMPLE_UPDATE_STATES.idle],
    ['downloading', SAMPLE_UPDATE_STATES.downloading],
    ['unsupported', SAMPLE_UPDATE_STATES.unsupported],
    ['a dismissed version', { ...SAMPLE_UPDATE_STATES.available, dismissedVersion: '1.0.1' }],
  ])('renders nothing for %s', async (_label, update) => {
    await start(update);
    const { container } = renderNotice();
    expect(container.innerHTML).toBe('');
  });

  it('compact (rail): the symbol only, named by the text; no cross', async () => {
    await start(SAMPLE_UPDATE_STATES.available);
    const requests = captureSettingsRequests();
    const user = userEvent.setup();
    renderNotice(true);
    const button = await screen.findByRole('button', { name: 'Parallax 1.0.1 available' });
    expect(button.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Hide this update hint' })).toBeNull();
    await user.click(button);
    expect(requests).toEqual([{ kind: 'settings', section: 'updates' }]);
  });

  it('is translated (German)', async () => {
    await start(SAMPLE_UPDATE_STATES.ready);
    act(() => {
      setLanguage('de');
    });
    renderNotice();
    expect(await screen.findByRole('button', { name: 'Parallax 1.0.1 bereit – neu starten' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diesen Update-Hinweis ausblenden' })).toBeTruthy();
  });
});
