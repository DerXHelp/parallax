import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import type { UpdateState } from '@shared/model';
import { SAMPLE_UPDATE_STATES, sampleTime, sampleUpdateState } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { startUpdatesHost, updateHostState, type UpdatesHost } from './testing';
import { UpdateBanner } from './UpdateBanner';

vi.setConfig({ testTimeout: 30_000 });

let running: UpdatesHost | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
  vi.unstubAllGlobals();
});

/** The Markdown slot of the tests: the plain text (the real renderer is features/transcript). */
const SLOTS: Partial<FeatureSlots> = {
  Markdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
};

async function start(update: UpdateState): Promise<UpdatesHost> {
  const started = startUpdatesHost({ hostState: updateHostState(update) });
  running = started;
  await waitFor(() => {
    expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.hostState ?? null).not.toBeNull();
  });
  return started;
}

function renderBanner() {
  return render(
    <FeatureSlotsProvider slots={SLOTS}>
      <TooltipProvider>
        <UpdateBanner />
      </TooltipProvider>
    </FeatureSlotsProvider>,
  );
}

function stubFetch(answer: (url: string) => Response) {
  const mock = vi.fn((input: string) => Promise.resolve(answer(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CHANGELOG = {
  version: '1.0.0',
  sections: [{ version: '1.0.0', date: '2026-11-20', body: '- Updates in the app' }],
};

describe('UpdateBanner: after a version change', () => {
  it('"Updated to <v>" with "What\'s new" since the previous version', async () => {
    await start(SAMPLE_UPDATE_STATES.justUpdated);
    const fetchMock = stubFetch(() => json(CHANGELOG));
    const user = userEvent.setup();
    renderBanner();
    const banner = await screen.findByRole('status');
    expect(within(banner).getByText('Updated to Parallax 1.0.0')).toBeTruthy();

    await user.click(within(banner).getByRole('button', { name: 'What’s new' }));
    const dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/changelog?for=installed&since=1.0.0-rc.4');
    expect(await within(dialog).findByText('- Updates in the app')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: /^Version 1\.0\.0 – / })).toBeTruthy();
    expect(within(dialog).getByText('Changes in Parallax 1.0.0')).toBeTruthy();
  });

  it('a step back says "Switched to <v> (was <v>)" and shows the own section', async () => {
    await start(sampleUpdateState({ justUpdated: { from: '1.0.1', to: '1.0.0', at: sampleTime() } }));
    const fetchMock = stubFetch(() => json(CHANGELOG));
    const user = userEvent.setup();
    renderBanner();
    expect(await screen.findByText('Switched to Parallax 1.0.0 (was 1.0.1)')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'What’s new' }));
    await screen.findByRole('dialog', { name: 'What’s new' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/changelog?for=installed');
  });

  it('"Dismiss" clears it on the server (update.dismiss justUpdated)', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.justUpdated);
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(host.commands).toContainEqual({ name: 'update.dismiss', what: 'justUpdated' });
    await waitFor(() => {
      expect(screen.queryByText('Updated to Parallax 1.0.0')).toBeNull();
    });
  });

  it('"What\'s new" shows a failed load in the dialog, with "Retry"', async () => {
    await start(SAMPLE_UPDATE_STATES.justUpdated);
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      return calls === 1 ? json(makeError('FILE_NOT_FOUND'), 404) : json(CHANGELOG);
    });
    const user = userEvent.setup();
    renderBanner();
    await user.click(await screen.findByRole('button', { name: 'What’s new' }));
    const dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText('The release notes could not be loaded.')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByText('- Updates in the app')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});

describe('UpdateBanner: a failed switch', () => {
  it('is an alert with the error, its reason and the log path to copy', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.failedUpdate);
    const user = userEvent.setup();
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Update to Parallax 1.0.1 failed – back on 1.0.0')).toBeTruthy();
    expect(within(alert).getByText('Switching to the new version failed.')).toBeTruthy();
    expect(within(alert).getByText('The new version did not start in time.')).toBeTruthy();
    const log = 'C:\\Users\\<USER>\\AppData\\Local\\Parallax\\logs\\update-20261117-120000.log';
    expect(within(alert).getByText(log)).toBeTruthy();

    await user.click(within(alert).getByRole('button', { name: 'Copy log path' }));
    expect(await navigator.clipboard.readText()).toBe(log);
    await waitFor(() => {
      expect(clientStore.getState().notices.map((notice) => notice.id)).toContain('update-log-copy');
    });

    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(host.commands).toContainEqual({ name: 'update.dismiss', what: 'failedUpdate' });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('without a log path there is no copy button', async () => {
    const failed = SAMPLE_UPDATE_STATES.failedUpdate.failedUpdate;
    if (failed === null) throw new Error('sample without failedUpdate');
    await start(sampleUpdateState({ failedUpdate: { ...failed, log: null } }));
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(within(alert).queryByRole('button', { name: 'Copy log path' })).toBeNull();
  });

  it('renders nothing without a change or a failure', async () => {
    await start(SAMPLE_UPDATE_STATES.available);
    const { container } = renderBanner();
    expect(container.innerHTML).toBe('');
  });

  it('is translated (German)', async () => {
    await start(SAMPLE_UPDATE_STATES.failedUpdate);
    act(() => {
      setLanguage('de');
    });
    renderBanner();
    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('Update auf Parallax 1.0.1 fehlgeschlagen – zurück auf 1.0.0'),
    ).toBeTruthy();
    expect(within(alert).getByText('Die neue Version ist nicht rechtzeitig gestartet.')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Pfad des Protokolls kopieren' })).toBeTruthy();
  });
});
