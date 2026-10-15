import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleHostState } from '@shared/samples';
import { App } from './App';
import { setLanguage } from './i18n';
import { PLAYGROUND_ENTRIES, PLAYGROUND_SESSION_KEYS } from './playground/scenarios';
import { startScenario, type RunningScenario } from './playground/PlaygroundScenario';
import { AppShell } from './shell/AppShell';
import { installShortcutListener } from './shell/shortcuts';
import { FeatureSlotsProvider } from './shell/slots';
import { resetClientStore } from './state/store';

// The whole shell renders per test: 1–3 s in a full `pnpm test`, up to 11 s when several runs load
// the machine (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 30_000 });

let running: RunningScenario | null = null;
let removeShortcuts: (() => void) | null = null;

function start(...args: Parameters<typeof startScenario>): RunningScenario {
  running = startScenario(...args);
  return running;
}

afterEach(() => {
  running?.stop();
  running = null;
  removeShortcuts?.();
  removeShortcuts = null;
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
  window.history.replaceState(null, '', '/');
  document.documentElement.classList.add('dark');
});

async function sidebar() {
  return screen.findByRole('navigation', { name: 'Sessions' });
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
    // The transcript slot placeholder counts the items of the subscribed snapshot.
    expect(await screen.findByText('Transcript view not connected (5 items).')).toBeTruthy();
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
    expect(await screen.findByText('3 open decisions')).toBeTruthy();
  });

  it('applies language and theme from host.state settings', async () => {
    const scenario = start('overview');
    render(<App />);
    await sidebar();
    act(() => {
      scenario.host.setHostState(sampleHostState({ settings: { language: 'de', theme: 'light' } }));
    });
    expect(await screen.findByText('Wartet auf dich (4)')).toBeTruthy();
    expect(document.documentElement.lang).toBe('de');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(screen.getByRole('navigation', { name: 'Sessions' })).toBeTruthy();
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

  it('shows the setup hint and server warnings', async () => {
    start('setup');
    render(<App />);
    expect(await screen.findByText('Claude Code needs attention')).toBeTruthy();
    expect(screen.getByText(/Claude Code was not found/)).toBeTruthy();
    expect(screen.getByText(/A damaged data file was set aside/)).toBeTruthy();
  });

  it('starts a new session from the empty state', async () => {
    const scenario = start('empty');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Welcome to Parallax' })).toBeTruthy();
    await user.type(screen.getByLabelText('Project folder'), 'D:\\work\\demo');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'demo' })).toBeTruthy();
    expect(scenario.host.commands).toContainEqual({ name: 'session.create', cwd: 'D:\\work\\demo' });
  });

  it('rejects unsafe paths before sending', async () => {
    const scenario = start('empty');
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Project folder'), '\\\\server\\share');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByText(/This path cannot be used/)).toBeTruthy();
    expect(scenario.host.commands).toHaveLength(0);
  });

  it('selects with Alt+1 and opens the shortcut help with ?', async () => {
    start('overview');
    removeShortcuts = installShortcutListener();
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
