import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { makeError } from '@shared/errors';
import type { HostState, SettingsPatch } from '@shared/model';
import { sampleHostState, sampleNotificationSettings, sampleSettings, sampleTime } from '@shared/samples';
import { DICTIONARIES, setLanguage, translate } from '@web/i18n';
import { resetAudio } from '@web/notifications/sounds';
import { FakeAudioContext } from '@web/notifications/testing';
import { requestShell, type SettingsSection } from '@web/shell/requests';
import { SettingsMenu } from '@web/shell/SettingsMenu';
import { ShellEffects } from '@web/shell/ShellEffects';
import { FeatureSlotsProvider, type FeatureSlots, type ProfilesSettingsSlotProps } from '@web/shell/slots';
import { createHostConnection, registerConnection, unregisterConnection } from '@web/state/connection';
import { FakeHost } from '@web/state/fake-host';
import { resetClientStore } from '@web/state/store';
import { createMemoryTransport } from '@web/state/transport';
import { TooltipProvider } from '@web/ui/tooltip';
import { de } from './i18n/de';
import { en } from './i18n/en';
import { PREFERENCES_SLOTS, SettingsPage } from './index';

// Dialog + FakeHost over the memory transport: generous limits for parallel checks.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

let cleanup: (() => void) | null = null;

beforeEach(() => {
  FakeAudioContext.reset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  resetAudio();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  act(() => {
    setLanguage('en');
  });
  resetClientStore();
  resetAudio();
  vi.unstubAllGlobals();
});

/**
 * A FakeHost as host `local`; `failUpdates` rejects every settings.update (STORE_WRITE_FAILED),
 * `failUpdate` those it returns true for.
 */
async function connect(
  options: { hostState?: HostState; failUpdates?: boolean; failUpdate?: (patch: SettingsPatch) => boolean } = {},
) {
  const transport = createMemoryTransport();
  const host = new FakeHost({
    transport,
    hostState: options.hostState ?? sampleHostState(),
    onCommand: (cmd) =>
      cmd.name === 'settings.update' && (options.failUpdates === true || options.failUpdate?.(cmd.patch) === true)
        ? { ok: false, error: makeError('STORE_WRITE_FAILED') }
        : undefined,
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
  await waitFor(() => {
    expect(connection.status()).toBe('open');
  });
  return host;
}

/** The `settings.update` patches the host received, in order. */
function patches(host: FakeHost): SettingsPatch[] {
  return host.commands.flatMap((cmd) => (cmd.name === 'settings.update' ? [cmd.patch] : []));
}

function renderPage(section: SettingsSection | null = null, slots: Partial<FeatureSlots> = {}) {
  const onClose = vi.fn();
  render(
    <FeatureSlotsProvider slots={slots}>
      <ShellEffects />
      <TooltipProvider>
        <SettingsPage section={section} onClose={onClose} />
      </TooltipProvider>
    </FeatureSlotsProvider>,
  );
  return { onClose, dialog: screen.getByRole('dialog') };
}

async function openSection(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('tab', { name }));
  return screen.getByRole('tabpanel', { name });
}

describe('settings page (WP-38): dialog, sections, Esc', () => {
  it('lists the six sections on the left and starts at the first one', async () => {
    await connect();
    renderPage();
    const list = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(
      within(list)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['General', 'Notifications', 'Sessions', 'Profiles', 'Server', 'About']);
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.getByRole('tabpanel', { name: 'General' })).toBeTruthy();
  });

  it('starts at the requested section; arrow keys move between sections', async () => {
    await connect();
    const user = userEvent.setup();
    renderPage('server');
    const tab = screen.getByRole('tab', { name: 'Server' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel', { name: 'Server' })).getByText('Port')).toBeTruthy();
    tab.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Esc closes the page', async () => {
    await connect();
    const user = userEvent.setup();
    const { onClose } = renderPage();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('General', () => {
  it('saves language and theme as top-level fields', async () => {
    const host = await connect();
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    await user.click(screen.getByRole('radio', { name: 'Deutsch' }));
    await waitFor(() => {
      expect(patches(host)).toEqual([{ theme: 'light' }, { language: 'de' }]);
    });
    // The page follows the language at once.
    expect(await screen.findByRole('dialog', { name: 'Einstellungen' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Design' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Hell' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Notifications', () => {
  it('per event: toast and sound switches send the whole notifications object', async () => {
    const host = await connect();
    const user = userEvent.setup();
    renderPage('notifications');
    const table = screen.getByRole('table', { name: 'Events' });
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Permission needed', 'Question', 'Plan to review', 'Done', 'Error', 'Usage limit']);
    await user.click(screen.getByRole('switch', { name: 'Windows notification: Question' }));
    await user.click(screen.getByRole('switch', { name: 'Sound: Done' }));
    const defaults = sampleNotificationSettings();
    await waitFor(() => {
      expect(patches(host)).toHaveLength(2);
    });
    const [first, second] = patches(host);
    expect(first).toEqual({
      notifications: {
        ...defaults,
        events: { ...defaults.events, question: { ...defaults.events.question, toast: false } },
      },
    });
    // The second change builds on the first (one top-level field, replaced as a whole).
    expect(second).toEqual({
      notifications: {
        ...defaults,
        events: {
          ...defaults.events,
          question: { ...defaults.events.question, toast: false },
          done: { ...defaults.events.done, sound: false },
        },
      },
    });
    expect(host.hostState.settings.notifications.events.done.sound).toBe(false);
    // Without sound the sound choice is disabled (the preview still plays).
    expect(screen.getByRole('combobox', { name: 'Sound choice: Done' }).hasAttribute('disabled')).toBe(true);
  });

  it('"Play" unlocks Web Audio and plays the chosen sound at the volume', async () => {
    await connect({
      hostState: sampleHostState({
        settings: sampleSettings({ notifications: sampleNotificationSettings({ volume: 0.3 }) }),
      }),
    });
    const user = userEvent.setup();
    renderPage('notifications');
    await user.click(screen.getByRole('button', { name: 'Play the sound for Plan to review' }));
    await waitFor(() => {
      expect(FakeAudioContext.instances).toHaveLength(1);
    });
    const context = FakeAudioContext.last();
    await waitFor(() => {
      expect(context.masterGains()).toEqual([0.3]);
    });
    // "bell" (plan's default): a note at 880 Hz with partials.
    expect(context.oscillators[0]?.frequency.events[0]?.value).toBe(880);
  });

  it('choosing another sound saves it and plays it', async () => {
    const host = await connect();
    const user = userEvent.setup();
    renderPage('notifications');
    const trigger = screen.getByRole('combobox', { name: 'Sound choice: Error' });
    expect(trigger.textContent).toContain('Alert');
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Ping' }));
    await waitFor(() => {
      expect(host.hostState.settings.notifications.events.error.soundId).toBe('ping');
    });
    expect(FakeAudioContext.last().oscillators[0]?.frequency.events[0]?.value).toBe(1318.51);
  });

  it('volume (slider 0–100 %), "Do not disturb", focus rule', async () => {
    const host = await connect();
    const user = userEvent.setup();
    renderPage('notifications');
    const slider = screen.getByRole('slider', { name: 'Volume' });
    expect(slider.getAttribute('aria-valuetext')).toBe('60 %');
    slider.focus();
    await user.keyboard('{PageUp}');
    await waitFor(() => {
      expect(host.hostState.settings.notifications.volume).toBe(0.7);
    });
    // The new loudness is played once.
    expect(FakeAudioContext.last().masterGains()).toEqual([0.7]);

    await user.click(screen.getByRole('switch', { name: 'Do not disturb' }));
    await waitFor(() => {
      expect(host.hostState.settings.notifications.doNotDisturb).toBe(true);
    });
    await user.click(screen.getByRole('radio', { name: 'Show a Windows notification' }));
    await waitFor(() => {
      expect(host.hostState.settings.notifications.focusedElsewhere).toBe('system');
    });
    expect(
      screen.getByRole('radiogroup', {
        name: 'While a Parallax window is in front and shows another session',
      }),
    ).toBeTruthy();
    // Every patch carries the whole notifications object.
    for (const patch of patches(host)) expect(Object.keys(patch.notifications ?? {})).toHaveLength(6);
  });

  it('keyboard steps on the volume are saved and played once, after the last key (R4W-17)', async () => {
    const host = await connect();
    const user = userEvent.setup({ delay: null });
    renderPage('notifications');
    const slider = screen.getByRole('slider', { name: 'Volume' });
    slider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(slider.getAttribute('aria-valuetext')).toBe('65 %');
    // One patch with the final value (Radix commits on every key: without grouping these were five).
    await waitFor(() => {
      expect(patches(host).map((patch) => patch.notifications?.volume)).toEqual([0.65]);
    });
    expect(FakeAudioContext.last().masterGains()).toEqual([0.65]);
  });

  it('the volume label points at no element (the slider thumb is named itself, V3-12)', async () => {
    await connect();
    renderPage('notifications');
    const field = document.querySelector('[data-setting="volume"]');
    expect(field?.querySelector('label')?.hasAttribute('for')).toBe(false);
    // Fields with a labelable control keep their <label for>.
    const dnd = document.querySelector('[data-setting="doNotDisturb"] label');
    expect(dnd?.getAttribute('for')).toBe(screen.getByRole('switch', { name: 'Do not disturb' }).id);
    // Fields with only a group below have none either.
    expect(document.querySelector('[data-setting="events"] label')?.hasAttribute('for')).toBe(false);
  });

  it('"Done" threshold: 0–600 seconds, invalid input stays local with an error', async () => {
    const host = await connect();
    const user = userEvent.setup();
    renderPage('notifications');
    const field = screen.getByRole('textbox', { name: 'Minimum turn length for “Done”' });
    expect((field as HTMLInputElement).value).toBe('20');
    await user.clear(field);
    await user.type(field, '601{Enter}');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Enter a whole number from 0 to 600.');
    await user.clear(field);
    await user.type(field, '2.5{Enter}');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(patches(host)).toEqual([]);
    await user.clear(field);
    await user.type(field, '0{Enter}');
    await waitFor(() => {
      expect(host.hostState.settings.notifications.doneMinSeconds).toBe(0);
    });
    expect(field.getAttribute('aria-invalid')).toBeNull();
    await user.clear(field);
    await user.type(field, '600');
    await user.tab();
    await waitFor(() => {
      expect(host.hostState.settings.notifications.doneMinSeconds).toBe(600);
    });
  });

  it('"Click opens the session" is disabled with the reason without system integration', async () => {
    await connect();
    renderPage('notifications');
    const toggle = screen.getByRole('switch', { name: 'Clicking a Windows notification opens the session' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(toggle.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/Only available for the installed Parallax server/)).toBeTruthy();
  });

  it('with system integration it saves openOnClick and shows PROTOCOL_HANDLER_FAILED', async () => {
    const host = await connect({
      hostState: sampleHostState({
        systemIntegration: true,
        warnings: [
          { id: 'w-protocol', error: makeError('PROTOCOL_HANDLER_FAILED'), at: sampleTime() },
          { id: 'w-autostart', error: makeError('AUTOSTART_FAILED'), at: sampleTime() },
        ],
      }),
    });
    const user = userEvent.setup();
    renderPage('notifications');
    expect(screen.queryByText(/Only available for the installed Parallax server/)).toBeNull();
    const panel = screen.getByRole('tabpanel', { name: 'Notifications' });
    expect(
      within(panel).getByText('Opening sessions from Windows notifications could not be set up.'),
    ).toBeTruthy();
    // The autostart warning belongs to "Server".
    expect(within(panel).queryByText('Autostart could not be set up.')).toBeNull();
    await user.click(
      screen.getByRole('switch', { name: 'Clicking a Windows notification opens the session' }),
    );
    await waitFor(() => {
      expect(host.hostState.settings.notifications.openOnClick).toBe(true);
    });
  });
});

describe('Sessions', () => {
  it('idle sleep (5–1440 minutes) and prompt suggestions', async () => {
    const host = await connect();
    const user = userEvent.setup();
    const { dialog } = renderPage();
    const panel = await openSection(user, 'Sessions');
    expect(within(panel).getByText(/one extra request per turn/)).toBeTruthy();
    const minutes = within(panel).getByRole('textbox', { name: 'Idle time before sleeping' });
    for (const invalid of ['4', '1441']) {
      await user.clear(minutes);
      await user.type(minutes, `${invalid}{Enter}`);
      expect(within(dialog).getByRole('alert').textContent).toBe('Enter a whole number from 5 to 1440.');
    }
    expect(patches(host)).toEqual([]);
    await user.clear(minutes);
    await user.type(minutes, '1440{Enter}');
    await waitFor(() => {
      expect(patches(host)).toEqual([{ idleSleep: { enabled: true, minutes: 1440 } }]);
    });
    await user.click(within(panel).getByRole('switch', { name: 'Put idle sessions to sleep' }));
    await user.click(within(panel).getByRole('switch', { name: 'Prompt suggestions' }));
    await waitFor(() => {
      expect(patches(host).slice(1)).toEqual([
        { idleSleep: { enabled: false, minutes: 1440 } },
        { promptSuggestions: true },
      ]);
    });
    // Without idle sleep the minutes cannot be edited.
    expect(minutes.hasAttribute('disabled')).toBe(true);
  });
});

describe('Server', () => {
  it('port: empty = default, 1024–65535, current port from the host state', async () => {
    const host = await connect({
      hostState: sampleHostState({ port: 4712, settings: sampleSettings({ port: 5000 }) }),
    });
    const user = userEvent.setup();
    renderPage('server');
    const field = screen.getByRole('textbox', { name: 'Port' });
    expect((field as HTMLInputElement).value).toBe('5000');
    expect(field.getAttribute('placeholder')).toBe('4711 (default)');
    expect(screen.getByText(/Current port: 4712/)).toBeTruthy();
    expect(screen.getByText(/after “Stop server” and a restart/)).toBeTruthy();
    for (const invalid of ['1023', '65536', 'abc']) {
      await user.clear(field);
      await user.type(field, `${invalid}{Enter}`);
      expect(screen.getByRole('alert').textContent).toBe(
        'Leave empty or enter a whole number from 1024 to 65535.',
      );
    }
    await user.clear(field);
    await user.type(field, '1024{Enter}');
    await user.clear(field);
    await user.type(field, '{Enter}');
    await waitFor(() => {
      expect(patches(host)).toEqual([{ port: 1024 }, { port: null }]);
    });
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('autostart is disabled with the reason without system integration', async () => {
    await connect();
    renderPage('server');
    const autostart = screen.getByRole('switch', { name: 'Start Parallax when you sign in to Windows' });
    expect(autostart.hasAttribute('disabled')).toBe(true);
    const openWindow = screen.getByRole('switch', { name: 'Also open a window at sign-in' });
    expect(openWindow.hasAttribute('disabled')).toBe(true);
    // Both switches name the reason (R4W-18: the sub-option too).
    const reasons = screen.getAllByText(/Only available for the installed Parallax server/);
    expect(reasons).toHaveLength(2);
    for (const toggle of [autostart, openWindow]) {
      const described = (toggle.getAttribute('aria-describedby') ?? '').split(' ');
      expect(reasons.some((reason) => described.includes(reason.closest('p')?.id ?? '-'))).toBe(true);
    }
  });

  it('"Also open a window" says it needs autostart while autostart is off (R4W-18)', async () => {
    await connect({
      hostState: sampleHostState({
        systemIntegration: true,
        settings: sampleSettings({ autostart: { enabled: false, openWindow: true } }),
      }),
    });
    renderPage('server');
    const openWindow = screen.getByRole('switch', { name: 'Also open a window at sign-in' });
    expect(openWindow.hasAttribute('disabled')).toBe(true);
    const reason = screen.getByText('Only while “Start Parallax when you sign in to Windows” is on.');
    expect((openWindow.getAttribute('aria-describedby') ?? '').split(' ')).toContain(reason.closest('p')?.id);
    expect(screen.queryByText(/Only available for the installed Parallax server/)).toBeNull();
  });

  it('with system integration: autostart, "open a window", AUTOSTART_FAILED', async () => {
    const host = await connect({
      hostState: sampleHostState({
        systemIntegration: true,
        warnings: [{ id: 'w-autostart', error: makeError('AUTOSTART_FAILED'), at: sampleTime() }],
      }),
    });
    const user = userEvent.setup();
    renderPage('server');
    expect(screen.getByText('Autostart could not be set up.')).toBeTruthy();
    const openWindow = screen.getByRole('switch', { name: 'Also open a window at sign-in' });
    expect(openWindow.hasAttribute('disabled')).toBe(true);
    await user.click(screen.getByRole('switch', { name: 'Start Parallax when you sign in to Windows' }));
    await waitFor(() => {
      expect(openWindow.hasAttribute('disabled')).toBe(false);
    });
    await user.click(openWindow);
    await waitFor(() => {
      expect(patches(host)).toEqual([
        { autostart: { enabled: true, openWindow: true } },
        { autostart: { enabled: true, openWindow: false } },
      ]);
    });
  });
});

describe('Profiles and About', () => {
  it('renders the ProfilesSettings slot of WP-36 (placeholder → a note)', async () => {
    await connect();
    const user = userEvent.setup();
    renderPage('profiles');
    expect(screen.getByText('The profile editor is not available in this view.')).toBeTruthy();
    cleanup?.();
    cleanup = null;
    await connect();
    function FakeProfiles() {
      return <p>profile editor</p>;
    }
    renderPage('about', { ProfilesSettings: FakeProfiles });
    const dialogs = screen.getAllByRole('dialog');
    const page = dialogs.at(-1);
    if (page === undefined) throw new Error('no dialog');
    await user.click(within(page).getByRole('tab', { name: 'Profiles' }));
    expect(within(page).getByText('profile editor')).toBeTruthy();
  });

  it('About shows the server facts of the settings menu', async () => {
    await connect();
    renderPage('about');
    const panel = screen.getByRole('tabpanel', { name: 'About' });
    expect(within(panel).getByText('Claude Code 2.1.300')).toBeTruthy();
    expect(within(panel).getByText('Agent SDK 0.3.296 · expects Claude Code 2.1.296 or newer')).toBeTruthy();
    expect(within(panel).getByText('Data: dev')).toBeTruthy();
    expect(within(panel).getByText('FakeBackend – no real Claude Code')).toBeTruthy();
  });
});

/** Stand-in for the profile editor of WP-36: one draft field, reports unsaved changes like it. */
function DraftProfiles({ onDirtyChange }: ProfilesSettingsSlotProps) {
  const [value, setValue] = useState('');
  useEffect(() => {
    onDirtyChange?.(value !== '');
  }, [value, onDirtyChange]);
  return (
    <input
      aria-label="profile draft"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
    />
  );
}

const DRAFT_SLOTS: Partial<FeatureSlots> = { ProfilesSettings: DraftProfiles };

function draftField(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('profile draft');
}

function profilesTab(): HTMLElement {
  return screen.getByRole('tab', { name: /^Profiles/ });
}

describe('unsaved profile drafts (R4W-01)', () => {
  it('a draft survives switching sections; the tab marks unsaved changes', async () => {
    await connect();
    const user = userEvent.setup();
    renderPage('profiles', DRAFT_SLOTS);
    await user.type(draftField(), 'secret-ish');
    expect(profilesTab().getAttribute('data-unsaved')).toBe('true');
    expect(profilesTab().textContent).toContain('unsaved changes');
    await user.click(screen.getByRole('tab', { name: 'General' }));
    // Kept mounted but hidden while another section shows.
    expect(screen.queryByRole('textbox', { name: 'profile draft' })).toBeNull();
    expect(draftField().closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true);
    await user.click(profilesTab());
    expect(draftField().value).toBe('secret-ish');
  });

  it('Esc with unsaved changes asks inline; "Keep editing" goes back to the field, "Discard and close" closes', async () => {
    await connect();
    const user = userEvent.setup();
    const { onClose, dialog } = renderPage('profiles', DRAFT_SLOTS);
    await user.type(draftField(), 'x');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    const confirm = within(dialog).getByText('Discard the unsaved profile changes?').closest('[data-slot="settings-close-confirm"]');
    expect(confirm).not.toBeNull();
    // R4W-24: the harmless choice has the focus.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(dialog.querySelector('[data-slot="settings-close-confirm"]')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(draftField());
    });
    expect(draftField().value).toBe('x');
    // Asked again: Esc while asking = keep editing; then discard closes.
    await user.keyboard('{Escape}');
    expect(within(dialog).getByRole('button', { name: 'Keep editing' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(dialog.querySelector('[data-slot="settings-close-confirm"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await user.click(within(dialog).getByRole('button', { name: 'Discard and close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('the close button and a click outside ask as well – also from another section', async () => {
    await connect();
    const user = userEvent.setup();
    const { onClose, dialog } = renderPage('profiles', DRAFT_SLOTS);
    await user.type(draftField(), 'x');
    await user.click(screen.getByRole('tab', { name: 'Server' }));
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(within(dialog).getByText('Discard the unsaved profile changes?')).toBeTruthy();
    // "Keep editing" from another section shows the profile editor again.
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(profilesTab().getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(profilesTab());
    });
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    if (overlay === null) throw new Error('no overlay');
    await user.click(overlay);
    expect(within(dialog).getByText('Discard the unsaved profile changes?')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('without unsaved changes nothing asks', async () => {
    await connect();
    const user = userEvent.setup();
    const { onClose } = renderPage('profiles', DRAFT_SLOTS);
    await user.type(draftField(), 'x');
    await user.clear(draftField());
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('a settings request while open switches the section and keeps the draft (no new page)', async () => {
    await connect();
    const user = userEvent.setup();
    renderPage('profiles', DRAFT_SLOTS);
    await user.type(draftField(), 'kept');
    let taken = false;
    act(() => {
      taken = requestShell({ kind: 'settings', section: 'about' });
    });
    expect(taken).toBe(true);
    expect(screen.getByRole('tab', { name: 'About' }).getAttribute('aria-selected')).toBe('true');
    act(() => {
      requestShell({ kind: 'settings', section: 'profiles' });
    });
    expect(draftField().value).toBe('kept');
    // Without a section the page stays where it is.
    act(() => {
      requestShell({ kind: 'settings' });
    });
    expect(profilesTab().getAttribute('aria-selected')).toBe('true');
  });
});

describe('saving (optimistic, rollback on failure)', () => {
  it('a refused change goes back and says so inside the dialog', async () => {
    const host = await connect({ failUpdates: true });
    const user = userEvent.setup();
    const { dialog } = renderPage('notifications');
    const toggle = screen.getByRole('switch', { name: 'Do not disturb' });
    await user.click(toggle);
    // The window's hint region lies behind the modal dialog: the page shows the error itself.
    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText('The setting could not be saved.')).toBeTruthy();
    expect(within(alert).getByText('Data could not be saved.')).toBeTruthy();
    await waitFor(() => {
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
    expect(host.hostState.settings.notifications.doNotDisturb).toBe(false);
    expect(patches(host)).toHaveLength(1);
  });

  it('the error stays when another field saves fine; "Dismiss" hides it (R4W-16)', async () => {
    await connect({ failUpdate: (patch) => patch.notifications !== undefined });
    const user = userEvent.setup();
    const { dialog } = renderPage('notifications');
    await user.click(screen.getByRole('switch', { name: 'Do not disturb' }));
    const alert = await within(dialog).findByRole('alert');
    await user.click(screen.getByRole('tab', { name: 'Sessions' }));
    const suggestions = screen.getByRole('switch', { name: 'Prompt suggestions' });
    await user.click(suggestions);
    await waitFor(() => {
      expect(suggestions.getAttribute('aria-checked')).toBe('true');
    });
    expect(within(dialog).getByRole('alert')).toBe(alert);
    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('a switch moves at once, before the server confirms it', async () => {
    await connect();
    const user = userEvent.setup();
    renderPage('sessions');
    const toggle = screen.getByRole('switch', { name: 'Prompt suggestions' });
    await user.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('a refused number goes back to the stored value', async () => {
    await connect({ failUpdates: true });
    const user = userEvent.setup();
    renderPage('sessions');
    const minutes = screen.getByRole('textbox', { name: 'Idle time before sleeping' });
    await user.clear(minutes);
    await user.type(minutes, '90{Enter}');
    await waitFor(() => {
      expect((minutes as HTMLInputElement).value).toBe('30');
    });
  });
});

describe('opened from the settings menu (request channel)', () => {
  function renderMenu() {
    render(
      <FeatureSlotsProvider slots={PREFERENCES_SLOTS}>
        <TooltipProvider>
          <SettingsMenu />
        </TooltipProvider>
      </FeatureSlotsProvider>,
    );
  }

  it('"Settings…" opens the page; closing gives the focus back to the settings button', async () => {
    await connect();
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Settings…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }));
    });
  });

  it('a request with a section opens the page there', async () => {
    await connect();
    renderMenu();
    let taken = false;
    act(() => {
      taken = requestShell({ kind: 'settings', section: 'notifications' });
    });
    expect(taken).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('tab', { name: 'Notifications' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

describe('preferences texts', () => {
  it('both languages have the same keys and no empty text', () => {
    const flatten = (value: unknown, prefix = ''): [string, string][] =>
      typeof value === 'string'
        ? [[prefix, value]]
        : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
            flatten(child, prefix === '' ? key : `${prefix}.${key}`),
          );
    const english = flatten(en);
    const german = flatten(de);
    expect(german.map(([key]) => key)).toEqual(english.map(([key]) => key));
    for (const [key, text] of [...english, ...german]) expect(text.trim(), key).not.toBe('');
  });

  it('is registered as namespace preferences; sound names are translated', () => {
    expect(DICTIONARIES.en.preferences).toBe(en);
    expect(DICTIONARIES.de.preferences).toBe(de);
    expect(translate('de', 'preferences.sounds.names.alert')).toBe('Warnton');
    expect(translate('de', 'preferences.notifications.kinds.plan')).toBe('Plan prüfen');
  });

  it('the page is German with language "de"', async () => {
    await connect({ hostState: sampleHostState({ settings: sampleSettings({ language: 'de' }) }) });
    renderPage('notifications');
    expect(await screen.findByRole('dialog', { name: 'Einstellungen' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Benachrichtigungen' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('switch', { name: 'Ton: Fertig' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Klang: Fehler' }).textContent).toContain('Warnton');
  });
});
