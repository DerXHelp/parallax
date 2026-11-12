import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetAudio } from '@web/notifications/sounds';
import { FakeAudioContext } from '@web/notifications/testing';
import { unregisterConnection } from '@web/state/connection';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { demos, slots } from './playground';

vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  act(() => {
    unregisterConnection();
  });
  resetClientStore();
  resetAudio();
  vi.unstubAllGlobals();
});

function demo(id: string) {
  const found = demos.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`demo ${id} missing`);
  return found;
}

describe('preferences playground', () => {
  it('has a page demo per section (with and without system integration), the sound preview and the WP-58 shell demos', () => {
    expect(demos.map((d) => d.id)).toEqual([
      'general',
      'notifications',
      'notifications-integration',
      'sessions',
      'files',
      'files-custom',
      'files-custom-errors',
      'profiles',
      'server',
      'server-integration',
      'server-warnings',
      'about',
      'sounds',
      'shell-header-panels',
      'shell-header-todos',
      'shell-session-menu',
      'shell-drop-overlay',
      'shell-window-900',
      'shell-window-700',
      'shell-app-busy',
      'shell-slot-error',
    ]);
    expect(slots.SettingsPage).toBeDefined();
  });

  it('the editor demos: found/not found, own program with preview, own program with errors', async () => {
    const { unmount } = render(<TooltipProvider>{demo('files-custom').render()}</TooltipProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => {
      expect(within(dialog).getByText('Found: C:\\Program Files\\Notepad++\\notepad++.exe')).toBeTruthy();
    });
    expect(dialog.querySelector('[data-slot="editor-preview"]')?.textContent).toContain('sublime_text.exe');
    unmount();
    act(() => {
      unregisterConnection();
    });

    render(<TooltipProvider>{demo('files-custom-errors').render()}</TooltipProvider>);
    const issues = await screen.findAllByText(/cannot be the editor|must contain \{file\}/);
    expect(issues).toHaveLength(2);
  });

  it('the shell demos render: header buttons with counters, slot error cards', async () => {
    const { unmount } = render(<TooltipProvider>{demo('shell-header-panels').render()}</TooltipProvider>);
    // Two headers (900 and 480 px; happy-dom does not measure, so both stay wide here).
    expect(await screen.findAllByRole('button', { name: 'Tasks – 2 background tasks running' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Plan' })).toHaveLength(2);
    unmount();
    act(() => {
      unregisterConnection();
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<TooltipProvider>{demo('shell-slot-error').render()}</TooltipProvider>);
    // The render error at once, the missing chunk once its import rejected.
    await waitFor(() => {
      expect(screen.getAllByText('This area could not be loaded')).toHaveLength(2);
    });
  });

  it('a page demo opens the page over the FakeHost with the variant applied', async () => {
    render(<TooltipProvider>{demo('server-warnings').render()}</TooltipProvider>);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('tab', { name: 'Server' }).getAttribute('aria-selected')).toBe('true');
    expect(await within(dialog).findByText('Autostart could not be set up.')).toBeTruthy();
    await waitFor(() => {
      expect(
        within(dialog)
          .getByRole('switch', { name: 'Start Parallax when you sign in to Windows' })
          .hasAttribute('disabled'),
      ).toBe(false);
    });
  });

  it('the sound demo plays every sound', async () => {
    FakeAudioContext.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    resetAudio();
    const user = userEvent.setup();
    render(<TooltipProvider>{demo('sounds').render()}</TooltipProvider>);
    for (const name of ['Chime', 'Ping', 'Pop', 'Bell', 'Alert']) {
      await user.click(screen.getByRole('button', { name }));
    }
    await waitFor(() => {
      expect(FakeAudioContext.last().masterGains()).toEqual([0.6, 0.6, 0.6, 0.6, 0.6]);
    });
  });
});
