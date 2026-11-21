import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import type { HostState, UpdateState } from '@shared/model';
import { SAMPLE_UPDATE_STATES, sampleUpdateRelease, sampleUpdateState } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import type { FakeHostOptions } from '@web/state/fake-host';
import { clientStore, resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import {
  CHECKOUT_APP,
  restartSessions,
  startUpdatesHost,
  updateHostState,
  type UpdatesHost,
} from './testing';
import { UpdatesSettings } from './UpdatesSettings';

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

const SLOTS: Partial<FeatureSlots> = {
  Markdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
};

async function start(
  update: UpdateState,
  options: { hostState?: Partial<HostState> } & Pick<FakeHostOptions, 'summaries' | 'onCommand'> = {},
): Promise<UpdatesHost> {
  const started = startUpdatesHost({
    hostState: updateHostState(update, options.hostState),
    summaries: options.summaries,
    onCommand: options.onCommand,
  });
  running = started;
  await waitFor(() => {
    expect(clientStore.getState().hosts[LOCAL_HOST_ID]?.hostState ?? null).not.toBeNull();
  });
  return started;
}

function renderSettings() {
  return render(
    <FeatureSlotsProvider slots={SLOTS}>
      <TooltipProvider>
        <UpdatesSettings />
      </TooltipProvider>
    </FeatureSlotsProvider>,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(answer: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn((input: string, init?: RequestInit) => Promise.resolve(answer(input, init)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function section(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="updates-settings"]');
  if (element === null) throw new Error('section missing');
  return element;
}

function statusLine(): string {
  return section().querySelector('[data-info="status"]')?.textContent ?? '';
}

/** Names of the action buttons and whether they are enabled. */
function actions(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const button of section().querySelectorAll<HTMLButtonElement>(
    '[data-block="status"] button[data-action]',
  )) {
    const action = button.dataset.action;
    if (action !== undefined && !action.startsWith('dismiss') && !action.includes('whats-new')) {
      result[action] = !button.disabled;
    }
  }
  return result;
}

describe('UpdatesSettings: version, status and buttons per status', () => {
  it('shows the installed version and build ID', async () => {
    await start(SAMPLE_UPDATE_STATES.idle);
    renderSettings();
    expect(await screen.findByText('Parallax 1.0.0')).toBeTruthy();
    expect(screen.getByText('Build 1.0.0+a1b2c3d')).toBeTruthy();
    expect(statusLine()).toBe('Parallax is up to date.');
    expect(section().querySelector('[data-info="checked"]')?.textContent).toMatch(/^Last checked /);
  });

  it.each<[string, UpdateState, string, Record<string, boolean>]>([
    [
      'idle',
      SAMPLE_UPDATE_STATES.idle,
      'Parallax is up to date.',
      { 'update-check': true, 'update-install-file': true },
    ],
    [
      'available',
      SAMPLE_UPDATE_STATES.available,
      'Parallax 1.0.1 is available.',
      { 'update-prepare': true, 'update-check': true, 'update-install-file': true },
    ],
    [
      'downloading',
      SAMPLE_UPDATE_STATES.downloading,
      'Downloading Parallax 1.0.1…',
      { 'update-check': false, 'update-install-file': false },
    ],
    [
      'ready',
      SAMPLE_UPDATE_STATES.ready,
      'Parallax 1.0.1 is ready. Restart to switch.',
      { 'update-restart': true, 'update-check': true, 'update-install-file': true },
    ],
    [
      'ready from a file',
      SAMPLE_UPDATE_STATES.readyFromFile,
      'Parallax 1.0.0-rc.4 from a file is ready. Restart to switch.',
      { 'update-restart': true, 'update-check': true, 'update-install-file': true },
    ],
    [
      'restarting',
      SAMPLE_UPDATE_STATES.restarting,
      'Parallax is restarting…',
      { 'update-check': false, 'update-install-file': false },
    ],
    [
      'a previous version',
      SAMPLE_UPDATE_STATES.previous,
      'Parallax is up to date.',
      { 'update-check': true, 'update-install-file': true, 'update-rollback': true },
    ],
    [
      'a previous version with other schemas',
      SAMPLE_UPDATE_STATES.previousNeedsRestore,
      'Parallax is up to date.',
      { 'update-check': true, 'update-install-file': true, 'update-rollback': true },
    ],
  ])('%s', async (_label, update, status, expected) => {
    await start(update);
    renderSettings();
    await screen.findByText('Parallax 1.0.0');
    expect(statusLine()).toBe(status);
    expect(actions()).toEqual(expected);
  });

  it.each([
    ['win32', '.zip'],
    ['linux', '.tar.gz,.gz'],
  ])('"Install from file" picks the archive of the platform (%s, WP-108)', async (platform, accept) => {
    await start(SAMPLE_UPDATE_STATES.idle, { hostState: { platform } });
    renderSettings();
    await screen.findByText('Parallax 1.0.0');
    expect(section().querySelector('[data-slot="update-file-input"]')?.getAttribute('accept')).toBe(accept);
  });

  it('downloading shows the progress', async () => {
    await start(SAMPLE_UPDATE_STATES.downloading);
    renderSettings();
    const bar = await screen.findByRole('progressbar', { name: 'Progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(section().querySelector('[data-info="progress"]')?.textContent).toContain('40%');
  });

  it('an offered version names size and release date; an older file says so', async () => {
    await start(SAMPLE_UPDATE_STATES.available);
    const { unmount } = renderSettings();
    const release = await waitFor(() => {
      const element = section().querySelector('[data-info="release"]');
      if (element === null) throw new Error('no release line');
      return element;
    });
    expect(release.textContent).toMatch(/^Released .+ · 13\.8 MB$/);
    unmount();
    running?.stop();
    await start(
      sampleUpdateState({
        status: 'ready',
        available: sampleUpdateRelease({
          version: '1.0.0-rc.4',
          source: 'file',
          size: null,
          downgrade: true,
        }),
      }),
    );
    renderSettings();
    expect(await screen.findByText('This version is older than the installed 1.0.0.')).toBeTruthy();
    expect(section().querySelector('[data-info="release"]')?.textContent).toMatch(/^From a file, built /);
  });
});

describe('UpdatesSettings: commands', () => {
  it('"Check now" sends update.check', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.idle);
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(host.commands).toContainEqual({ name: 'update.check' });
  });

  it('"Update now" sends update.prepare with the offered version; then "Restart now" shows', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.available);
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(host.commands).toContainEqual({ name: 'update.prepare', version: '1.0.1' });
    expect(await screen.findByRole('button', { name: 'Restart now' })).toBeTruthy();
  });

  it('a refused command shows its error and reason in the section', async () => {
    await start(SAMPLE_UPDATE_STATES.idle, {
      onCommand: (cmd) =>
        cmd.name === 'update.check'
          ? { ok: false, error: makeError('UPDATE_BUSY', { status: 'preparing' }) }
          : undefined,
    });
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Check now' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('That did not work.')).toBeTruthy();
    expect(within(alert).getByText('Another update step is running. Try again in a moment.')).toBeTruthy();
    expect(within(alert).getByText('A preparation is running right now.')).toBeTruthy();
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the last failure of the host shows with its reason; "Dismiss" sends update.dismiss error', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.checkFailed);
    const user = userEvent.setup();
    renderSettings();
    const error = await waitFor(() => {
      const element = section().querySelector<HTMLElement>('[data-slot="update-error"]');
      if (element === null) throw new Error('no error');
      return element;
    });
    // UPDATE_CHECK_FAILED is a warning: announced politely.
    expect(error.getAttribute('role')).toBe('status');
    expect(within(error).getByText('Could not check for updates.')).toBeTruthy();
    expect(within(error).getByText('No connection to GitHub.')).toBeTruthy();
    await user.click(within(error).getByRole('button', { name: 'Dismiss' }));
    expect(host.commands).toContainEqual({ name: 'update.dismiss', what: 'error' });
    await waitFor(() => {
      expect(section().querySelector('[data-slot="update-error"]')).toBeNull();
    });
  });

  it('"Check for updates automatically" saves settings.updates', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.idle);
    const user = userEvent.setup();
    renderSettings();
    const toggle = await screen.findByRole('switch', { name: 'Check for updates automatically' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(host.commands).toContainEqual({
      name: 'settings.update',
      patch: { updates: { check: false, registry: null } },
    });
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('the npm registry for the SDK: checked, saved with Enter, empty = npm configuration', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.idle);
    const user = userEvent.setup();
    renderSettings();
    const input = await screen.findByRole('textbox', { name: 'npm registry for the Agent SDK' });
    expect((input as HTMLInputElement).value).toBe('');
    await user.type(input, 'https://user:secret@nexus.example.com/npm/{Enter}');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter an https address without user name or password.')).toBeTruthy();
    expect(host.commands.filter((command) => command.name === 'settings.update')).toEqual([]);

    await user.clear(input);
    await user.type(input, ' https://nexus.example.com/repository/npm-all/ {Enter}');
    expect(host.commands).toContainEqual({
      name: 'settings.update',
      patch: { updates: { check: true, registry: 'https://nexus.example.com/repository/npm-all/' } },
    });
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('https://nexus.example.com/repository/npm-all/');
    });

    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(host.commands).toContainEqual({
      name: 'settings.update',
      patch: { updates: { check: true, registry: null } },
    });
  });
});

describe('UpdatesSettings: restart and going back', () => {
  it('"Restart now" asks first, naming the sessions it stops; confirm sends update.apply', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.ready, { summaries: restartSessions() });
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart Parallax now?' });
    const working = within(dialog).getByRole('heading', { name: 'Working (1)' }).closest('section');
    const waiting = within(dialog).getByRole('heading', { name: 'Waiting for you (1)' }).closest('section');
    if (working === null || waiting === null) throw new Error('lists missing');
    expect(within(working).getByText('Refactor the parser')).toBeTruthy();
    expect(within(waiting).getByText('Approve the migration')).toBeTruthy();
    expect(within(dialog).getByText('1 idle session (no running work) will be closed.')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(host.updateSwitches).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Restart now' }));
    const again = await screen.findByRole('dialog', { name: 'Restart Parallax now?' });
    await user.click(within(again).getByRole('button', { name: 'Restart now' }));
    expect(host.updateSwitches).toEqual([{ name: 'update.apply', version: '1.0.1', acceptDataLoss: false }]);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('a refused switch shows in the dialog with its reason', async () => {
    await start(SAMPLE_UPDATE_STATES.ready, {
      onCommand: (cmd) =>
        cmd.name === 'update.apply'
          ? {
              ok: false,
              error: makeError('UPDATE_RESTART_FAILED', { version: '1.0.1', reason: 'handshake' }),
            }
          : undefined,
    });
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Restart now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restart Parallax now?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restart now' }));
    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText('The switch could not be started.')).toBeTruthy();
    expect(within(alert).getByText('The switch did not report back in time.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Restart now' })).toHaveProperty('disabled', false);
  });

  it('"Back to <p>" without other schemas goes back after the confirmation', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.previous);
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'Back to 1.0.0-rc.4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Go back to Parallax 1.0.0-rc.4?' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByText('No session is running – nothing will be interrupted.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Go back' }));
    expect(host.updateSwitches).toEqual([
      { name: 'update.rollback', version: '1.0.0-rc.4', acceptDataLoss: false },
    ]);
  });

  it('other schemas: warning with the backup date, the tick allows it (acceptDataLoss)', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.previousNeedsRestore);
    const user = userEvent.setup();
    renderSettings();
    const back = await screen.findByRole('button', { name: 'Back to 1.0.0-rc.4' });
    expect(section().querySelector('[data-info="rollback-hint"]')?.textContent).toMatch(
      /^Going back restores the backup of .+: changes since then will be lost\.$/,
    );
    expect(back.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(back);
    const dialog = await screen.findByRole('dialog', { name: 'Go back to Parallax 1.0.0-rc.4?' });
    expect(within(dialog).getByText(/^Changes since .+ will be lost$/)).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Go back' });
    expect(confirm).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByRole('checkbox', { name: 'I understand – restore the backup' }));
    expect(confirm).toHaveProperty('disabled', false);
    await user.click(confirm);
    expect(host.updateSwitches).toEqual([
      { name: 'update.rollback', version: '1.0.0-rc.4', acceptDataLoss: true },
    ]);
  });

  it('other schemas without a backup: "Back to" is blocked and says why', async () => {
    await start(
      sampleUpdateState({ previous: { version: '1.0.0-rc.4', needsRestore: true, backupAt: null } }),
    );
    renderSettings();
    const back = await screen.findByRole('button', { name: 'Back to 1.0.0-rc.4' });
    expect(back).toHaveProperty('disabled', true);
    expect(screen.getByText('Going back to 1.0.0-rc.4 needs a backup, and there is none.')).toBeTruthy();
  });
});

describe('UpdatesSettings: install from file', () => {
  it('POSTs the zip as application/zip; then "Package received" until the check shows', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.idle);
    const fetchMock = stubFetch(() => json({ accepted: true }, 202));
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole('button', { name: 'Install from file…' });
    const input = section().querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    expect(input.accept).toBe('.zip');
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'parallax-1.0.0-rc.4-win.zip', {
      type: 'application/x-zip-compressed',
    });
    await user.upload(input, file);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/update/package',
      expect.objectContaining({ method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
    );
    expect(await screen.findByText('Package received – it is being checked.')).toBeTruthy();
    // The server checks the package (preparing) and offers it (ready).
    act(() => {
      host.setHostState({ ...host.hostState, update: sampleUpdateState({ status: 'preparing' }) });
    });
    await waitFor(() => {
      expect(statusLine()).toBe('Checking the package…');
    });
    act(() => {
      host.setHostState({ ...host.hostState, update: SAMPLE_UPDATE_STATES.readyFromFile });
    });
    await waitFor(() => {
      expect(screen.queryByText('Package received – it is being checked.')).toBeNull();
    });
    expect(statusLine()).toBe('Parallax 1.0.0-rc.4 from a file is ready. Restart to switch.');
  });

  it('"Package received" survives an earlier error sent again and ends with the check\'s own error', async () => {
    const { host } = await start(SAMPLE_UPDATE_STATES.checkFailed);
    stubFetch(() => json({ accepted: true }, 202));
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole('button', { name: 'Install from file…' });
    const input = section().querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    await user.upload(input, new File(['zip'], 'parallax-1.0.0-rc.4-win.zip', { type: 'application/zip' }));
    expect(await screen.findByText('Package received – it is being checked.')).toBeTruthy();
    // The same (re-parsed) error of the earlier check comes with the next host states.
    const earlier = SAMPLE_UPDATE_STATES.checkFailed.error;
    if (earlier === null) throw new Error('sample without error');
    act(() => {
      host.setHostState({
        ...host.hostState,
        update: sampleUpdateState({
          status: 'preparing',
          error: { ...earlier, params: { ...earlier.params } },
        }),
      });
    });
    await waitFor(() => {
      expect(statusLine()).toBe('Checking the package…');
    });
    expect(screen.getByText('Package received – it is being checked.')).toBeTruthy();
    // The check fails: back to idle with its own error.
    act(() => {
      host.setHostState({
        ...host.hostState,
        update: sampleUpdateState({ error: makeError('UPDATE_INVALID_PACKAGE', { reason: 'layout' }) }),
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Package received – it is being checked.')).toBeNull();
    });
    expect(statusLine()).toBe('Parallax is up to date.');
    expect(screen.getByText('The archive does not have the layout of a Parallax package.')).toBeTruthy();
  });

  it('a refused package shows the translated error and its reason', async () => {
    await start(SAMPLE_UPDATE_STATES.idle);
    stubFetch(() => json(makeError('UPDATE_INVALID_PACKAGE', { reason: 'zip' }), 400));
    const user = userEvent.setup();
    renderSettings();
    await screen.findByRole('button', { name: 'Install from file…' });
    const input = section().querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    await user.upload(input, new File(['not a zip'], 'notes.zip', { type: 'application/zip' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('The package could not be installed.')).toBeTruthy();
    expect(within(alert).getByText('This is not a valid Parallax package.')).toBeTruthy();
    expect(within(alert).getByText('The file is not a readable zip archive.')).toBeTruthy();
  });
});

describe('UpdatesSettings: dialogs and checkout', () => {
  it('"What\'s new in <v>" loads the notes of the offered version', async () => {
    await start(SAMPLE_UPDATE_STATES.available);
    const fetchMock = stubFetch(() =>
      json({ version: '1.0.1', sections: [{ version: '1.0.1', date: null, body: '- Faster start' }] }),
    );
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'What’s new in 1.0.1' }));
    const dialog = await screen.findByRole('dialog', { name: 'What’s new' });
    expect(await within(dialog).findByText('- Faster start')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Version 1.0.1' })).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/changelog?for=available');
  });

  it('"License" and "Third-party notices" show the text in a scroll area; a failure in the dialog', async () => {
    await start(SAMPLE_UPDATE_STATES.idle);
    const fetchMock = stubFetch((url) =>
      url.endsWith('file=license')
        ? json({ file: 'license', text: 'MIT License\n\nCopyright (c) 2026' })
        : json(makeError('FILE_NOT_FOUND'), 404),
    );
    const user = userEvent.setup();
    renderSettings();
    await user.click(await screen.findByRole('button', { name: 'License' }));
    const license = await screen.findByRole('dialog', { name: 'License' });
    const text = await within(license).findByText(/MIT License/);
    expect(text.tagName).toBe('PRE');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/notices?file=license');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Third-party notices' }));
    const notices = await screen.findByRole('dialog', { name: 'Third-party notices' });
    const alert = await within(notices).findByRole('alert');
    expect(within(alert).getByText('The file could not be loaded.')).toBeTruthy();
    expect(within(alert).getByText('The file does not exist (any more).')).toBeTruthy();
  });

  it('a checkout: "development build – updates via git" and "What\'s new" only', async () => {
    await start(SAMPLE_UPDATE_STATES.unsupported, { hostState: { app: CHECKOUT_APP } });
    renderSettings();
    expect(await screen.findByText('Development build 1.0.0+dev.4f5e6d7 – updates via git')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'License' })).toBeNull();
    expect([...section().querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'What’s new',
    ]);
  });

  it('is translated (German)', async () => {
    await start(SAMPLE_UPDATE_STATES.previousNeedsRestore);
    act(() => {
      setLanguage('de');
    });
    renderSettings();
    expect(await screen.findByRole('button', { name: 'Jetzt prüfen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aus Datei installieren…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zurück zu 1.0.0-rc.4' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Automatisch nach Updates suchen' })).toBeTruthy();
    expect(statusLine()).toBe('Parallax ist aktuell.');
  });
});
