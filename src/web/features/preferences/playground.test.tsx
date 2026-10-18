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
  it('has a page demo per section (with and without system integration) and the sound preview', () => {
    expect(demos.map((d) => d.id)).toEqual([
      'general',
      'notifications',
      'notifications-integration',
      'sessions',
      'profiles',
      'server',
      'server-integration',
      'server-warnings',
      'about',
      'sounds',
    ]);
    expect(slots.SettingsPage).toBeDefined();
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
