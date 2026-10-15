import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeError } from '@shared/errors';
import { SAMPLE_IDS, sampleSessionSnapshot, sampleSummary } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { NotificationCenter } from '@web/shell/NotificationCenter';
import { SettingsMenu } from '@web/shell/SettingsMenu';
import { TooltipProvider } from '@web/ui/tooltip';
import { createHostConnection, registerConnection, unregisterConnection } from './connection';
import { FakeHost } from './fake-host';
import { ERROR_NOTICE_DURATION_MS, dismissNotice, showErrorNotice, showTextNotice } from './notices';
import { clientStore, resetClientStore } from './store';
import { createMemoryTransport } from './transport';

const KEY = `local:${SAMPLE_IDS.entry}`;

// Menu interaction through user-event: up to 2 s in a full `pnpm test`, over 6 s when several runs
// load the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.useRealTimers();
  unregisterConnection();
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
});

function region() {
  return screen.getByRole('region', { name: 'Notifications' });
}

describe('local notices (R1W-07)', () => {
  it('shows a translated hint in the notification region, re-translated on a language switch', () => {
    render(<NotificationCenter />);
    act(() => {
      showTextNotice('settings.saveFailed', undefined, { tone: 'error' });
    });
    expect(within(region()).getByRole('alert').textContent).toContain('The setting could not be saved.');
    act(() => {
      setLanguage('de');
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Die Einstellung konnte nicht gespeichert werden.',
    );
  });

  it('replaces a notice with the same id, auto-dismisses and can be dismissed', () => {
    vi.useFakeTimers();
    render(<NotificationCenter />);
    act(() => {
      showErrorNotice(makeError('DECISION_ALREADY_RESOLVED'), { id: 'same' });
      showErrorNotice(makeError('DECISION_ALREADY_RESOLVED'), { id: 'same' });
    });
    expect(within(region()).getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText('This decision was already answered.')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(ERROR_NOTICE_DURATION_MS);
    });
    expect(within(region()).queryAllByRole('alert')).toHaveLength(0);

    act(() => {
      showTextNotice('settings.saveFailed', undefined, { id: 'sticky', durationMs: null, tone: 'info' });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(region()).getAllByRole('status')).toHaveLength(1);
    act(() => {
      dismissNotice('sticky');
    });
    expect(within(region()).queryAllByRole('status')).toHaveLength(0);
  });

  it('offers "Show session" for a notice with a session key', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <NotificationCenter />
      </TooltipProvider>,
    );
    act(() => {
      showErrorNotice(makeError('SESSION_BUSY'), { sessionKey: KEY });
    });
    await user.click(screen.getByRole('button', { name: 'Show session' }));
    expect(clientStore.getState().selectedSession).toBe(KEY);
    expect(clientStore.getState().notices).toHaveLength(0);
  });

  it('SettingsMenu reports a failed settings.update (settings.saveFailed)', async () => {
    const transport = createMemoryTransport();
    const host = new FakeHost({
      transport,
      summaries: [sampleSummary()],
      sessions: [sampleSessionSnapshot()],
      onCommand: (cmd) =>
        cmd.name === 'settings.update' ? { ok: false, error: makeError('STORE_WRITE_FAILED') } : undefined,
    });
    const connection = createHostConnection({ hostId: 'local', createTransport: () => transport });
    registerConnection(connection);
    connection.start();
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <SettingsMenu />
        <NotificationCenter />
      </TooltipProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));
    await waitFor(() => {
      expect(screen.getByText('The setting could not be saved.')).toBeTruthy();
    });
    expect(host.hostState.settings.theme).toBe('dark');
    host.dispose();
  });
});
