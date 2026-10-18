import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { requestShell } from './requests';
import { SettingsMenu } from './SettingsMenu';
import { FeatureSlotsProvider, type FeatureSlots, type SettingsPageSlotProps } from './slots';

afterEach(() => {
  resetClientStore();
});

/** Stand-in for the page of WP-38: shows the section and closes on a click. */
function FakePage({ section, onClose }: SettingsPageSlotProps) {
  return (
    <div role="dialog" aria-label="fake settings" data-section={section ?? 'none'}>
      <button type="button" onClick={onClose}>
        close page
      </button>
    </div>
  );
}

const SLOTS: Partial<FeatureSlots> = { SettingsPage: FakePage };

function renderMenu(slots: Partial<FeatureSlots> = {}) {
  render(
    <FeatureSlotsProvider slots={slots}>
      <TooltipProvider>
        <SettingsMenu />
      </TooltipProvider>
    </FeatureSlotsProvider>,
  );
}

describe('settings menu → settings page (WP-38, request "settings")', () => {
  it('without a wired page there is no entry and nobody takes the request', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('menuitemradio', { name: 'Dark' });
    expect(screen.queryByRole('menuitem', { name: 'Settings…' })).toBeNull();
    let taken = true;
    act(() => {
      taken = requestShell({ kind: 'settings' });
    });
    expect(taken).toBe(false);
  });

  it('"Settings…" opens the page at the first section; the page closes itself', async () => {
    const user = userEvent.setup();
    renderMenu(SLOTS);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Settings…' }));
    const page = await screen.findByRole('dialog', { name: 'fake settings' });
    expect(page.getAttribute('data-section')).toBe('none');
    await user.click(screen.getByRole('button', { name: 'close page' }));
    expect(screen.queryByRole('dialog', { name: 'fake settings' })).toBeNull();
  });

  it('a request names the section', async () => {
    renderMenu(SLOTS);
    let taken = false;
    act(() => {
      taken = requestShell({ kind: 'settings', section: 'server' });
    });
    expect(taken).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: 'fake settings' }).getAttribute('data-section')).toBe(
        'server',
      );
    });
    act(() => {
      requestShell({ kind: 'settings', section: 'about' });
    });
    expect(screen.getByRole('dialog', { name: 'fake settings' }).getAttribute('data-section')).toBe('about');
  });
});
