import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import {
  sampleClaudeInstallStatus,
  sampleContextGauge,
  sampleHostState,
  sampleProfileSummary,
  sampleSettings,
  sampleTime,
} from '@shared/samples';
import { APP_SLOTS, App } from './App';
import { Composer } from './features/composer/Composer';
import { DecisionBar } from './features/decisions/DecisionBar';
import { DecisionCard } from './features/decisions/DecisionCard';
import { PlanSidePanel } from './features/decisions/PlanSidePanel';
import { PREFERENCES_SLOTS, SettingsPage } from './features/preferences';
import { ProfilesSettings } from './features/profiles';
import { TRANSCRIPT_SLOTS } from './features/transcript/slots';
import { installResizeObserver } from './features/transcript/testing';
import { setLanguage } from './i18n';
import { startNotificationDelivery } from './notifications/delivery';
import { resetNotificationHint } from './notifications/permission';
import { setSystemNotifier, type SystemNotifier } from './notifications/system';
import { PLAYGROUND_ENTRIES, PLAYGROUND_SESSION_KEYS } from './playground/scenarios';
import { startScenario, type RunningScenario } from './playground/PlaygroundScenario';
import { AppShell } from './shell/AppShell';
import { closeNewSession } from './shell/NewSessionDialog';
import { requestShell, type ShellRequest } from './shell/requests';
import { closeShortcutHelp } from './shell/ShortcutHelp';
import { installShortcutListener } from './shell/shortcuts';
import { FeatureSlotsProvider } from './shell/slots';
import { createHostConnection, registerConnection, unregisterConnection } from './state/connection';
import { FakeHost } from './state/fake-host';
import { resetClientStore } from './state/store';
import { createMemoryTransport } from './state/transport';

// The whole shell renders per test: 1–3 s in a full `pnpm test`, up to 11 s when several runs load
// the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

let running: RunningScenario | null = null;
const cleanups: (() => void)[] = [];

function start(...args: Parameters<typeof startScenario>): RunningScenario {
  running = startScenario(...args);
  return running;
}

/** A Web Notification stand-in with the given permission (requests grant it). */
function fakeNotifier(initial: 'default' | 'granted' | 'denied') {
  let permission: 'default' | 'granted' | 'denied' = initial;
  const shown: { title: string; tag: string; onClick: () => void }[] = [];
  const requests = vi.fn(() => {
    permission = 'granted';
    return Promise.resolve(permission);
  });
  const notifier: SystemNotifier = {
    permission: () => permission,
    requestPermission: requests,
    show(options) {
      shown.push(options);
      return { close: () => undefined };
    },
  };
  return { notifier, shown, requests };
}

afterEach(() => {
  act(() => {
    closeNewSession();
    closeShortcutHelp();
  });
  running?.stop();
  running = null;
  for (const cleanup of cleanups.splice(0)) cleanup();
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
  resetNotificationHint();
  window.history.replaceState(null, '', '/');
  document.documentElement.classList.add('dark');
});

async function sidebar() {
  return screen.findByRole('navigation', { name: 'Sessions' });
}

function header(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="session-header"]');
  if (element === null) throw new Error('session header missing');
  return element;
}

describe('App shell over the memory transport', () => {
  it('lists every session with its status text and sets the window title', async () => {
    start('overview');
    render(<App />);
    const nav = await sidebar();
    expect(within(nav).getAllByRole('button')).toHaveLength(14);
    for (const label of [
      'Needs permission',
      'Has a question',
      'Plan ready for review',
      'Waiting to resume',
      'Error',
      'Sleeping',
    ]) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Waiting for you (4)')).toBeTruthy();
    expect(document.title).toBe('(4) Parallax');
    expect(screen.getByRole('heading', { level: 1, name: 'Sample session' })).toBeTruthy();
  });

  it('selects a session on click, subscribes it and mirrors it in the hash', async () => {
    const scenario = start('overview');
    const user = userEvent.setup();
    render(<App />);
    const nav = await sidebar();
    await user.click(within(nav).getByText('Three open decisions'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Three open decisions' })).toBeTruthy();
    expect(window.location.hash).toBe(`#session=${PLAYGROUND_SESSION_KEYS.decisions}`);
    expect(scenario.host.subscribed.has(PLAYGROUND_ENTRIES.decisions)).toBe(true);
    // The real decision bar: the oldest open decision plus "+2 more".
    const bar = await screen.findByRole('region', { name: 'Decisions' });
    expect(within(bar).getByText('+2 more')).toBeTruthy();
  });

  it('applies language and theme from host.state settings', async () => {
    const scenario = start('overview');
    render(<App />);
    await sidebar();
    act(() => {
      scenario.host.setHostState(
        sampleHostState({ settings: sampleSettings({ language: 'de', theme: 'light' }) }),
      );
    });
    expect(await screen.findByText('Wartet auf dich (4)')).toBeTruthy();
    expect(document.documentElement.lang).toBe('de');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeTruthy();
    // The wired features follow the language too.
    expect(screen.getByRole('textbox', { name: 'Nachricht an Claude' })).toBeTruthy();
  });

  it('changes the theme through the settings menu (settings.update)', async () => {
    const scenario = start('overview');
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Light' }));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
    expect(scenario.host.commands).toContainEqual({ name: 'settings.update', patch: { theme: 'light' } });
    expect(scenario.host.hostState.settings.theme).toBe('light');
  });

  it('shows a banner while reconnecting and recovers', async () => {
    const scenario = start('overview');
    render(<App />);
    await sidebar();
    act(() => {
      scenario.host.restart();
    });
    expect(await screen.findByText('Connection lost – reconnecting…')).toBeTruthy();
    // Real backoff (~0.5 s) plus the new handshake; 3 s were tight under parallel load.
    await waitFor(
      () => {
        expect(screen.queryByText('Connection lost – reconnecting…')).toBeNull();
      },
      { timeout: 15_000 },
    );
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('shows "Not signed in" without opening a WebSocket', async () => {
    const scenario = start('signed-out');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Not signed in' })).toBeTruthy();
    expect(screen.getByText(/The sign-in link is invalid or has expired/)).toBeTruthy();
    expect(scenario.host.transport.connectCount).toBe(0);
  });

  it('shows the setup hint (translated error code) and server warnings', async () => {
    start('setup');
    render(<App />);
    expect(await screen.findByText('Claude Code needs attention')).toBeTruthy();
    expect(screen.getByText(/Claude Code was not found/)).toBeTruthy();
    expect(screen.getByText('Details: “pnpm preflight”.')).toBeTruthy();
    expect(screen.getByText(/A damaged data file was set aside/)).toBeTruthy();
  });

  it('creates a new session from the empty state, selects it and focuses its message field', async () => {
    const scenario = start('empty');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome to Parallax' })).toBeTruthy();
    await user.type(screen.getByLabelText('Project folder'), 'D:\\work\\demo');
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'demo' })).toBeTruthy();
    // WP-36: the profile is always explicit (the default one is pre-selected).
    expect(scenario.host.commands).toContainEqual({
      name: 'session.create',
      cwd: 'D:\\work\\demo',
      profileId: 'standard',
    });
    const input = await screen.findByRole('textbox', { name: 'Message to Claude' });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it('rejects unsafe paths before sending', async () => {
    const scenario = start('empty');
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Project folder'), '\\\\server\\share');
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    expect(await screen.findByText(/This path cannot be used/)).toBeTruthy();
    expect(scenario.host.commands).toHaveLength(0);
  });

  it('opens "New session" from the sidebar, offers recent projects and creates the session', async () => {
    const scenario = start('overview');
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    await user.click(screen.getByRole('button', { name: 'New session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    const recent = within(dialog).getByRole('list', { name: 'Recent projects' });
    const projects = within(recent).getAllByRole('button');
    // WP-36: up to eight distinct folders.
    expect(projects).toHaveLength(8);
    // The most recent folder first (sessions sorted by activity, case-insensitive dedup).
    const first = projects[0];
    if (first === undefined) throw new Error('no recent project');
    await user.click(first);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Project folder').value).toBe(
      'D:\\work\\parallax\\docs',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(scenario.host.commands).toContainEqual({
      name: 'session.create',
      cwd: 'D:\\work\\parallax\\docs',
      profileId: 'standard',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'docs' })).toBeTruthy();
    expect(window.location.hash).toMatch(/^#session=local:en_/);
  });

  it('shows a server error of session.create in the form (translated) and selects nothing', async () => {
    const transport = createMemoryTransport();
    const host = new FakeHost({
      transport,
      onCommand: (cmd) =>
        cmd.name === 'session.create' ? { ok: false, error: makeError('CWD_NOT_FOUND') } : undefined,
    });
    const connection = createHostConnection({
      hostId: LOCAL_HOST_ID,
      createTransport: () => transport,
      reload: () => undefined,
    });
    registerConnection(connection);
    connection.start();
    cleanups.push(() => {
      unregisterConnection(LOCAL_HOST_ID);
      host.dispose();
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Project folder'), 'D:\\missing');
    await user.click(screen.getByRole('button', { name: 'Create session' }));
    expect(await screen.findByText('The folder does not exist.')).toBeTruthy();
    expect(host.commands).toEqual([{ name: 'session.create', cwd: 'D:\\missing', profileId: 'standard' }]);
    expect(window.location.hash).toBe('');
  });

  it('selects with Alt+1 and opens the shortcut help with ?', async () => {
    start('overview');
    cleanups.push(installShortcutListener());
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    await user.keyboard('{Alt>}1{/Alt}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Three open decisions' })).toBeTruthy();
    await user.keyboard('?');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Select session 1–9 in the sidebar')).toBeTruthy();
  });

  it('renders the feature slots that are set', async () => {
    start('overview');
    render(
      <FeatureSlotsProvider
        slots={{ Transcript: ({ sessionKey }) => <div>custom transcript {sessionKey}</div> }}
      >
        <AppShell />
      </FeatureSlotsProvider>,
    );
    expect(await screen.findByText(`custom transcript ${PLAYGROUND_SESSION_KEYS.main}`)).toBeTruthy();
  });
});

describe('wired feature slots (WP-20b, WP-40)', () => {
  it('APP_SLOTS holds the components of WP-15, WP-16, WP-36 and WP-38', () => {
    expect(APP_SLOTS).toEqual({
      ...TRANSCRIPT_SLOTS,
      DecisionBar,
      DecisionCard,
      SidePanel: PlanSidePanel,
      Composer,
      SettingsPage,
      ProfilesSettings,
    });
    expect(APP_SLOTS.Transcript).toBe(TRANSCRIPT_SLOTS.Transcript);
    expect(APP_SLOTS.Markdown).toBe(TRANSCRIPT_SLOTS.Markdown);
    expect(APP_SLOTS.ToolInputPreview).toBe(TRANSCRIPT_SLOTS.ToolInputPreview);
    expect(APP_SLOTS.SettingsPage).toBe(PREFERENCES_SLOTS.SettingsPage);
  });

  it('"Settings…" opens the settings page; its section "Profiles" shows the profile editor (WP-40)', async () => {
    start('overview');
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Settings…' }));
    const page = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(page).getByRole('tab', { name: 'Profiles' }));
    const profiles = await within(page).findByRole('tabpanel', { name: 'Profiles' });
    // The real slot of WP-36, not the "not available" hint of the placeholder.
    expect(profiles.querySelector('[data-slot="profiles-settings"]')).not.toBeNull();
    expect(profiles.querySelector('[data-slot="profile-list"]')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    });
  });

  it('every request of the shell channel has a mounted handler in the app (WP-40)', async () => {
    start('overview');
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Sample session' });
    // false = nobody took it (shell/requests.ts) – a missing registration is an integration bug.
    const requests: ShellRequest[] = [
      { kind: 'quickSwitcher' },
      { kind: 'conversations', sessionKey: PLAYGROUND_SESSION_KEYS.main },
      { kind: 'sessionInfo', sessionKey: PLAYGROUND_SESSION_KEYS.main },
      { kind: 'newSession', cwd: 'D:\\work\\parallax' },
      { kind: 'settings', section: 'about' },
      { kind: 'renameTitle', sessionKey: PLAYGROUND_SESSION_KEYS.main },
    ];
    for (const request of requests) {
      let taken = false;
      act(() => {
        taken = requestShell(request);
      });
      expect(taken, request.kind).toBe(true);
      if (request.kind !== 'renameTitle') {
        await screen.findByRole('dialog');
        await user.keyboard('{Escape}');
        await waitFor(() => {
          expect(screen.queryByRole('dialog')).toBeNull();
        });
      }
    }
    // The pre-filled folder reached the dialog (WP-36 handler).
    act(() => {
      requestShell({ kind: 'newSession', cwd: 'D:\\work\\parallax' });
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector<HTMLInputElement>('input[name="cwd"]')?.value).toBe('D:\\work\\parallax');
  });

  it('renders the transcript, the decision bar and the composer of the selected session', async () => {
    cleanups.push(installResizeObserver());
    const scenario = start('overview', { select: PLAYGROUND_SESSION_KEYS.decisions });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Three open decisions' });
    expect(await screen.findByRole('region', { name: 'Transcript' })).toBeTruthy();
    const bar = await screen.findByRole('region', { name: 'Decisions' });
    expect(bar.closest('[data-decision-bar]')?.getAttribute('data-decision-bar')).toBe(
      PLAYGROUND_SESSION_KEYS.decisions,
    );
    expect(screen.getByRole('textbox', { name: 'Message to Claude' })).toBeTruthy();
    // The transcript shows the main session's messages once selected.
    await user.click(
      within(screen.getByRole('navigation', { name: 'Sessions' })).getByText('Sample session'),
    );
    expect(await screen.findByText('Say OK.')).toBeTruthy();
    expect(scenario.host.subscribed.has(PLAYGROUND_ENTRIES.main)).toBe(true);
    expect(screen.queryByRole('region', { name: 'Decisions' })).toBeNull();
  });

  it('sends a prompt from the composer (session.sendPrompt)', async () => {
    const scenario = start('overview');
    const user = userEvent.setup();
    render(<App />);
    const input = await screen.findByRole('textbox', { name: 'Message to Claude' });
    await user.type(input, 'Hello there{Enter}');
    await waitFor(() => {
      expect(scenario.host.commands).toContainEqual({
        name: 'session.sendPrompt',
        entryId: PLAYGROUND_ENTRIES.main,
        prompt: { text: 'Hello there', attachments: [] },
        priority: 'next',
      });
    });
  });
});

describe('session header (status only, ADR-041/042)', () => {
  it('shows status (icon + text), queue badge, mode, model and context fill', async () => {
    const scenario = start('overview');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Sample session' });
    act(() => {
      scenario.host.patchSummary(
        PLAYGROUND_ENTRIES.main,
        {
          permissionMode: 'plan',
          model: 'claude-opus-5-5',
          context: sampleContextGauge({ percentage: 72, totalTokens: 720_000, source: 'estimate' }),
        },
        { runState: 'working', queuedPrompts: 2 },
      );
    });
    await waitFor(() => {
      expect(header().dataset.status).toBe('working');
    });
    const view = within(header());
    expect(view.getByText('Working', { selector: '[data-slot="header-status"]' })).toBeTruthy();
    expect(view.getByText('2 queued')).toBeTruthy();
    expect(view.getByText('Plan')).toBeTruthy();
    expect(view.getByText('claude-opus-5-5')).toBeTruthy();
    const meter = view.getByRole('meter', { name: 'Context' });
    expect(meter.getAttribute('aria-valuenow')).toBe('72');
    expect(meter.dataset.level).toBe('warning');
    // Read-only: the pickers live in the composer.
    expect(view.queryAllByRole('button')).toHaveLength(0);
  });

  it('hides the context fill without a gauge and marks expired decisions', async () => {
    const scenario = start('overview');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Sample session' });
    act(() => {
      scenario.host.patchSummary(
        PLAYGROUND_ENTRIES.main,
        { context: null },
        {
          runState: 'idle',
          unread: false,
          decisions: { permission: 0, question: 0, plan: 0, oldestKind: null, expired: 1 },
        },
      );
    });
    await waitFor(() => {
      expect(header().dataset.status).toBe('idle');
    });
    const view = within(header());
    expect(view.queryByRole('meter')).toBeNull();
    expect(view.getByText('1 expired decision')).toBeTruthy();
  });

  it('shows the Claude Code version of the session, red when older than the SDK expects (R3-01, C.7)', async () => {
    const scenario = start('overview');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Sample session' });
    const version = () => header().querySelector<HTMLElement>('[data-slot="header-cli-version"]');
    expect(version()?.textContent).toBe('CLI 2.1.300');
    expect(version()?.dataset.versionStatus).toBe('ok');
    act(() => {
      scenario.host.patchSummary(PLAYGROUND_ENTRIES.main, { cliVersion: '2.1.200' });
    });
    await waitFor(() => {
      expect(version()?.dataset.versionStatus).toBe('too_old');
    });
    // C.7: the SDK expects 2.1.296 (host.state.sdkClaudeCodeVersion); screen readers get the reason.
    expect(
      within(header()).getByText(
        'Older than the version the Agent SDK expects (2.1.296) – update Claude Code.',
      ),
    ).toBeTruthy();
    expect(within(header()).queryAllByRole('button')).toHaveLength(0);
    // Not started yet (no init): no version entry at all.
    act(() => {
      scenario.host.patchSummary(PLAYGROUND_ENTRIES.main, { cliVersion: null });
    });
    await waitFor(() => {
      expect(version()).toBeNull();
    });
  });

  it('names a session without a title after its folder (V2-05)', async () => {
    const scenario = start('overview');
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Sample session' });
    act(() => {
      scenario.host.patchSummary(PLAYGROUND_ENTRIES.main, { title: '', titleSource: 'none' });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'sample' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Sessions' });
    expect(within(nav).getByText('sample')).toBeTruthy();
  });
});

describe('server facts (R3-01, R3-02) and the setup check (R3-03)', () => {
  it('the settings menu shows Claude Code (version, path), SDK, Parallax, data folder and the FakeBackend', async () => {
    start('overview');
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    // R3-02: the FakeBackend is marked next to the product name.
    expect(document.querySelector('[data-slot="backend-fake"]')?.textContent).toContain('Fake');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const info = await screen.findByRole('group', { name: 'About this server' });
    expect(within(info).getByText('Claude Code 2.1.300')).toBeTruthy();
    expect(within(info).getByText('C:\\Users\\user\\.local\\bin\\claude.exe')).toBeTruthy();
    expect(within(info).getByText('Agent SDK 0.3.296 · expects Claude Code 2.1.296 or newer')).toBeTruthy();
    expect(within(info).getByText('Parallax 0.0.0')).toBeTruthy();
    expect(within(info).getByText('Data: dev')).toBeTruthy();
    expect(within(info).getByText('FakeBackend – no real Claude Code')).toBeTruthy();
    // No menu items: the facts are read-only.
    expect(within(info).queryAllByRole('menuitem')).toHaveLength(0);
    // V2-09: the radio groups of the menu are labelled by their headings.
    expect(screen.getByRole('group', { name: 'Theme' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy();
  });

  it('the real backend has no "Fake" badge; a too old CLI is red in the menu', async () => {
    const scenario = start('overview');
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    act(() => {
      scenario.host.setHostState(
        sampleHostState({
          backend: 'sdk',
          dev: false,
          dataDirLabel: '%LOCALAPPDATA%\\Parallax',
          profiles: [
            sampleProfileSummary({
              claude: sampleClaudeInstallStatus({ version: '2.1.200', versionStatus: 'too_old' }),
            }),
          ],
        }),
      );
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="backend-fake"]')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const info = await screen.findByRole('group', { name: 'About this server' });
    expect(within(info).getByText('Older than the Agent SDK expects (at least 2.1.296).')).toBeTruthy();
    expect(info.querySelector('[data-info="claude"]')?.getAttribute('data-version-status')).toBe('too_old');
    expect(within(info).getByText('Data: %LOCALAPPDATA%\\Parallax')).toBeTruthy();
    expect(info.querySelector('[data-info="backend"]')).toBeNull();
  });

  it('while "Profil testen" runs: a neutral checking line, no warning; afterwards the real result', async () => {
    const scenario = start('checking');
    const user = userEvent.setup();
    render(<App />);
    const hint = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-slot="setup-hint"]');
      if (element === null) throw new Error('no setup hint yet');
      return element;
    });
    expect(hint.dataset.state).toBe('checking');
    expect(within(hint).getByText('Checking Claude Code…')).toBeTruthy();
    expect(screen.queryByText('Claude Code needs attention')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Claude Code: checking…')).toBeTruthy();
    await user.keyboard('{Escape}');
    // The check found no claude: now the warning with the translated reason.
    act(() => {
      scenario.host.setHostState(
        sampleHostState({
          setupRequired: true,
          profiles: [
            sampleProfileSummary({
              claude: sampleClaudeInstallStatus({
                state: 'not_found',
                path: null,
                version: null,
                versionStatus: 'unknown',
                error: makeError('CLAUDE_NOT_FOUND'),
              }),
            }),
          ],
        }),
      );
    });
    expect(await screen.findByText('Claude Code needs attention')).toBeTruthy();
    expect(document.querySelector<HTMLElement>('[data-slot="setup-hint"]')?.dataset.state).toBe('required');
    // …and an ok check removes the hint.
    act(() => {
      scenario.host.setHostState(sampleHostState());
    });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="setup-hint"]')).toBeNull();
    });
  });

  it('counts server messages that failed the contract at the connection indicator (R3-05)', async () => {
    const scenario = start('overview');
    render(<App />);
    await sidebar();
    expect(
      document.querySelector('[data-slot="connection-indicator"]')?.hasAttribute('data-invalid-messages'),
    ).toBe(false);
    act(() => {
      // A known type whose payload does not match the schema (e.g. a new field format).
      const broken = JSON.stringify({ type: 'summary.upsert', summary: { entryId: 'broken' } });
      scenario.host.transport.serverSendRaw(broken);
      scenario.host.transport.serverSendRaw(broken);
    });
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="connection-indicator"]')?.getAttribute('data-invalid-messages'),
      ).toBe('2');
    });
    expect(screen.getByText('2 server messages did not match the contract and were dropped.')).toBeTruthy();
  });

  it('the window title drops "(n)" once the server is stopped (V2-08)', async () => {
    const scenario = start('overview');
    render(<App />);
    await sidebar();
    expect(document.title).toBe('(4) Parallax');
    act(() => {
      scenario.host.transport.serverClose(4503);
    });
    expect(await screen.findByRole('heading', { name: 'Parallax server stopped' })).toBeTruthy();
    await waitFor(() => {
      expect(document.title).toBe('Parallax');
    });
  });
});

describe('notifications (A.9, Phase-1 minimum)', () => {
  it('shows a server notification of the focused window as an in-app hint with "Show session"', async () => {
    const fake = fakeNotifier('granted');
    const scenario = start('overview');
    cleanups.push(startNotificationDelivery({ notifier: fake.notifier }));
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    act(() => {
      scenario.host.sendRaw({
        type: 'notify',
        notification: {
          id: 'nt-1',
          kind: 'plan',
          entryId: PLAYGROUND_ENTRIES.decisions,
          title: 'Three open decisions',
          delivery: 'in_app',
          at: sampleTime(),
        },
      });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(region).findByText('Three open decisions – plan ready for review')).toBeTruthy();
    expect(fake.shown).toHaveLength(0);
    await user.click(within(region).getByRole('button', { name: 'Show session' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Three open decisions' })).toBeTruthy();
    expect(within(region).queryByText('Three open decisions – plan ready for review')).toBeNull();
  });

  it('notify.clear retracts the hint (answered in another window)', async () => {
    const fake = fakeNotifier('default');
    const scenario = start('overview');
    cleanups.push(startNotificationDelivery({ notifier: fake.notifier }));
    render(<App />);
    await sidebar();
    act(() => {
      scenario.host.sendRaw({
        type: 'notify',
        notification: {
          id: 'nt-2',
          kind: 'permission',
          entryId: PLAYGROUND_ENTRIES.decisions,
          title: 'Three open decisions',
          delivery: 'system',
          at: sampleTime(),
        },
      });
    });
    const region = screen.getByRole('region', { name: 'Notifications' });
    // Without permission the system channel falls back to the in-app hint.
    expect(await within(region).findByText('Three open decisions – needs permission')).toBeTruthy();
    act(() => {
      scenario.host.sendRaw({ type: 'notify.clear', entryId: PLAYGROUND_ENTRIES.decisions });
    });
    await waitFor(() => {
      expect(within(region).queryByText('Three open decisions – needs permission')).toBeNull();
    });
  });

  it('asks for the notification permission only on a click ("Enable notifications")', async () => {
    const fake = fakeNotifier('default');
    cleanups.push(setSystemNotifier(fake.notifier));
    start('overview');
    const user = userEvent.setup();
    render(<App />);
    await sidebar();
    expect(fake.requests).not.toHaveBeenCalled();
    const banner = screen
      .getByText('Get notified when a session needs you')
      .closest<HTMLElement>('[data-slot="notification-permission"]');
    if (banner === null) throw new Error('banner missing');
    await user.click(within(banner).getByRole('button', { name: 'Enable notifications' }));
    expect(fake.requests).toHaveBeenCalledOnce();
    expect(await screen.findByText('Notifications are on.')).toBeTruthy();
    expect(screen.queryByText('Get notified when a session needs you')).toBeNull();
  });

  it('WP22-03: no "Enable notifications" hint while the server shows native Windows toasts', async () => {
    const fake = fakeNotifier('default');
    cleanups.push(setSystemNotifier(fake.notifier));
    const scenario = start('overview');
    render(<App />);
    await sidebar();
    expect(screen.getByText('Get notified when a session needs you')).toBeTruthy();
    act(() => {
      scenario.host.setHostState(sampleHostState({ nativeNotifications: true }));
    });
    await waitFor(() => {
      expect(screen.queryByText('Get notified when a session needs you')).toBeNull();
    });
    expect(fake.requests).not.toHaveBeenCalled();
  });

  it('"Not now" hides the hint for good; the settings menu still offers it', async () => {
    const fake = fakeNotifier('default');
    cleanups.push(setSystemNotifier(fake.notifier));
    start('overview');
    const user = userEvent.setup();
    const view = render(<App />);
    await sidebar();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText('Get notified when a session needs you')).toBeNull();
    view.unmount();
    render(<App />);
    await sidebar();
    expect(screen.queryByText('Get notified when a session needs you')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Enable notifications' }));
    expect(fake.requests).toHaveBeenCalledOnce();
  });
});
