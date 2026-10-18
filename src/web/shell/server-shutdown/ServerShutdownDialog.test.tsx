import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import { sampleHostState, sampleSettings, sampleStatusFacts, sampleSummary } from '@shared/samples';
import { App } from '@web/App';
import { DICTIONARIES, setLanguage, translate } from '@web/i18n';
import { startScenario, type RunningScenario } from '@web/playground/PlaygroundScenario';
import { createHostConnection, registerConnection, unregisterConnection } from '@web/state/connection';
import { FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { TooltipProvider } from '@web/ui/tooltip';
import { SettingsMenu } from '../SettingsMenu';
import { closeServerShutdown } from './ServerShutdownDialog';
import { de } from './i18n/de';
import { en } from './i18n/en';

// Full app over the memory transport: generous limits, the machine may be busy (parallel checks).
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

let running: RunningScenario | null = null;
let cleanup: (() => void) | null = null;

afterEach(() => {
  act(() => {
    closeServerShutdown();
  });
  running?.stop();
  running = null;
  cleanup?.();
  cleanup = null;
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
  window.history.replaceState(null, '', '/');
});

async function openConfirmation(user: ReturnType<typeof userEvent.setup>, item = 'Stop server…') {
  await user.click(await screen.findByRole('button', { name: /^(Settings|Einstellungen)$/ }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

describe('"Stop server" (A.10: confirmation lists working and waiting sessions)', () => {
  it('names the working and waiting sessions, then sends server.shutdown and shows "server stopped"', async () => {
    running = startScenario('overview');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sessions' });
    await openConfirmation(user);

    const dialog = await screen.findByRole('dialog', { name: 'Stop the Parallax server?' });
    const working = within(dialog).getByRole('heading', { name: 'Working (3)' }).closest('section');
    const waiting = within(dialog).getByRole('heading', { name: 'Waiting for you (3)' }).closest('section');
    if (working === null || waiting === null) throw new Error('sections missing');
    for (const title of ['Stream a long answer', 'Starting up', 'Background build is running']) {
      expect(within(working).getByText(title)).toBeTruthy();
    }
    for (const title of ['Three open decisions', 'Answer the color question', 'Review the migration plan']) {
      expect(within(waiting).getByText(title)).toBeTruthy();
    }
    // Status as icon + text (never color only).
    expect(within(waiting).getByText('Plan ready for review')).toBeTruthy();
    expect(within(dialog).getByText('3 idle sessions (no running work) will be closed.')).toBeTruthy();
    // Sleeping, interrupted, failed and external sessions are not affected.
    expect(within(dialog).queryByText('Sleeping since yesterday')).toBeNull();
    expect(within(dialog).queryByText('Plan approval after restart')).toBeNull();
    expect(running.host.commands).not.toContainEqual({ name: 'server.shutdown' });

    await user.click(within(dialog).getByRole('button', { name: 'Stop server' }));
    expect(running.host.commands).toContainEqual({ name: 'server.shutdown' });
    expect(await screen.findByRole('heading', { name: 'Parallax server stopped' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel closes the confirmation without a command; focus starts on Cancel', async () => {
    running = startScenario('overview');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sessions' });
    await openConfirmation(user);
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Parallax server?' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel);
    });
    await user.click(cancel);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(running.host.commands).not.toContainEqual({ name: 'server.shutdown' });
    // V2-07: the menu item that opened it is gone – the focus returns to the settings button.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }));
    });
  });

  it('is translated (German)', async () => {
    running = startScenario('overview');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sessions' });
    act(() => {
      running?.host.setHostState(
        sampleHostState({ settings: sampleSettings({ language: 'de', theme: 'dark' }) }),
      );
    });
    await screen.findByText('Wartet auf dich (4)');
    await openConfirmation(user, 'Server beenden…');
    const dialog = await screen.findByRole('dialog', { name: 'Parallax-Server beenden?' });
    expect(within(dialog).getByRole('heading', { name: 'Arbeitet (3)' })).toBeTruthy();
    expect(
      within(dialog).getByText('3 Sessions im Leerlauf (ohne laufende Arbeit) werden geschlossen.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Server beenden' })).toBeTruthy();
  });

  it('shows the error of a rejected command and stays open', async () => {
    const transport = createMemoryTransport();
    const host = new FakeHost({
      transport,
      summaries: [sampleSummary({ title: 'Busy', status: sampleStatusFacts({ runState: 'working' }) })],
      onCommand: (cmd) =>
        cmd.name === 'server.shutdown' ? { ok: false, error: makeError('SERVER_SHUTTING_DOWN') } : undefined,
    });
    const connection = createHostConnection({
      hostId: LOCAL_HOST_ID,
      createTransport: () => transport,
      reload: () => undefined,
    });
    registerConnection(connection);
    connection.start();
    cleanup = () => {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    };
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <SettingsMenu />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(connection.status()).toBe('open');
    });
    await openConfirmation(user);
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Parallax server?' });
    expect(within(dialog).getByText('Busy')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Stop server' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText('The server could not be stopped.')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('only idle sessions: no lists, the idle line stands on its own (V3-13)', async () => {
    const transport = createMemoryTransport();
    const host = new FakeHost({
      transport,
      summaries: [sampleSummary({ title: 'Quiet', status: sampleStatusFacts({ runState: 'idle' }) })],
    });
    const connection = createHostConnection({
      hostId: LOCAL_HOST_ID,
      createTransport: () => transport,
      reload: () => undefined,
    });
    registerConnection(connection);
    connection.start();
    cleanup = () => {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    };
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <SettingsMenu />
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(connection.status()).toBe('open');
    });
    await openConfirmation(user);
    const dialog = await screen.findByRole('dialog', { name: 'Stop the Parallax server?' });
    expect(within(dialog).queryByRole('heading', { name: /^Working/ })).toBeNull();
    expect(within(dialog).queryByRole('heading', { name: /^Waiting/ })).toBeNull();
    expect(within(dialog).queryByText('Quiet')).toBeNull();
    expect(within(dialog).getByText('1 idle session (no running work) will be closed.')).toBeTruthy();
  });
});

describe('"Parallax was updated" offers "Stop server" (V2-04)', () => {
  /** A server of another build: the window stays outdated after its (stubbed) reload. */
  function outdated(onCommand?: ConstructorParameters<typeof FakeHost>[0]['onCommand']) {
    const transport = createMemoryTransport();
    const host = new FakeHost({ transport, buildId: 'older-build', onCommand });
    const reload = vi.fn();
    const connection = createHostConnection({
      hostId: LOCAL_HOST_ID,
      createTransport: () => transport,
      reload,
      reloadGuard: { read: () => null, write: () => undefined },
    });
    registerConnection(connection);
    connection.start();
    cleanup = () => {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    };
    return { host, reload };
  }

  it('offers Reload and Stop server; the confirmation stops the server', async () => {
    const { host, reload } = outdated();
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Parallax was updated' })).toBeTruthy();
    expect(reload).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stop server…' }));
    // An inline confirmation (no session list here), Cancel focused like in the dialog.
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel);
    });
    expect(screen.getByText(/Every Claude session of this server is stopped too/)).toBeTruthy();
    expect(host.commands).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Stop server' }));
    expect(await screen.findByRole('heading', { name: 'Parallax server stopped' })).toBeTruthy();
    expect(host.commands).toEqual([{ name: 'server.shutdown' }]);
  });

  it('a refused stop shows the error and the manual way out; Cancel goes back', async () => {
    outdated((cmd) =>
      cmd.name === 'server.shutdown' ? { ok: false, error: makeError('SERVER_SHUTTING_DOWN') } : undefined,
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Stop server…' }));
    await user.click(await screen.findByRole('button', { name: 'Stop server' }));
    expect(await screen.findByText('The server could not be stopped.')).toBeTruthy();
    expect(screen.getByText(/end the Parallax server \(node\.exe\) in the Task Manager/)).toBeTruthy();
    // Not stuck: both buttons work again.
    expect(screen.getByRole('button', { name: 'Stop server' }).hasAttribute('disabled')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Parallax was updated' })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop server…' }));
    });
  });
});

describe('serverShutdown texts', () => {
  it('both languages have the same keys and no empty text', () => {
    const texts = (dictionary: typeof en): string[] =>
      Object.values(dictionary).flatMap((value) =>
        typeof value === 'string' ? [value] : Object.values(value),
      );
    expect(Object.keys(de)).toEqual(Object.keys(en));
    for (const text of [...texts(en), ...texts(de)]) expect(text.trim()).not.toBe('');
  });

  it('is registered as namespace serverShutdown (WP-20b) with the shell plural rules', () => {
    expect(DICTIONARIES.en.serverShutdown).toBe(en);
    expect(DICTIONARIES.de.serverShutdown).toBe(de);
    expect(translate('en', 'serverShutdown.working', { count: 1200 })).toBe('Working (1,200)');
    expect(translate('de', 'serverShutdown.working', { count: 1200 })).toBe('Arbeitet (1.200)');
    expect(translate('en', 'serverShutdown.idle', { count: 1 })).toBe(
      '1 idle session (no running work) will be closed.',
    );
    expect(translate('de', 'serverShutdown.idle', { count: 2 })).toBe(
      '2 Sessions im Leerlauf (ohne laufende Arbeit) werden geschlossen.',
    );
    expect(translate('en', 'serverShutdown.title')).toBe('Stop the Parallax server?');
  });

  it('the idle line reads on its own – no "more"/"weitere" that needs a list before it (V3-13)', () => {
    for (const text of [...Object.values(en.idle), ...Object.values(de.idle)]) {
      expect(text).not.toMatch(/\bmore\b|weitere/i);
    }
  });
});
