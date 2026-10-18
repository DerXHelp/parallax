import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaygroundDemo } from '@web/playground/types';
import { closeNewSession } from '@web/shell/NewSessionDialog';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { DEMO_PROFILE_IDS } from './lib/demo-host';
import { demos, slots } from './playground';
import { ProfilesSettings } from './ProfilesSettings';

// Demos over the FakeHost (ops per animation frame): seconds under parallel load (docs/wp/FLAKES.md).
vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  act(() => {
    closeNewSession();
  });
  resetClientStore();
});

function demo(id: string): PlaygroundDemo {
  const found = demos.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`demo ${id} missing`);
  return found;
}

function show(id: string) {
  render(<TooltipProvider>{demo(id).render()}</TooltipProvider>);
}

describe('profiles playground (WP-36 requirement 5)', () => {
  it('offers the dialog, folder browser and editor demos and the ProfilesSettings slot', () => {
    expect(demos.map((entry) => entry.id)).toEqual([
      'new-session',
      'new-session-prefilled',
      'new-session-broken',
      'folder-browser-roots',
      'folder-browser-folder',
      'folder-browser-error',
      'editor-default',
      'editor-new',
      'editor-findings',
      'editor-in-use',
    ]);
    expect(slots?.ProfilesSettings).toBe(ProfilesSettings);
  });

  it('opens "New session" with the folder and profile of the prefill', async () => {
    show('new-session-prefilled');
    const view = await screen.findByRole('dialog', { name: 'New session' });
    expect(within(view).getByLabelText<HTMLInputElement>('Project folder').value).toBe('D:\\work\\parallax');
    await waitFor(() => {
      expect(view.querySelector('[data-slot="profile-select"]')?.getAttribute('data-profile-id')).toBe(
        DEMO_PROFILE_IDS.work,
      );
    });
    expect(within(view).getByRole('list', { name: 'Recent projects' })).toBeTruthy();
  });

  it('shows the folder browser falling back to the roots after an unreadable start folder', async () => {
    show('folder-browser-error');
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    expect(await within(browser).findByText('This folder cannot be read (no permission).')).toBeTruthy();
    await waitFor(() => {
      expect(within(browser).getAllByRole('option')).toHaveLength(3);
    });
  });

  it('shows the editor with findings per line', async () => {
    show('editor-findings');
    const form = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-slot="profile-editor"][data-profile-id="${DEMO_PROFILE_IDS.gateway}"]`,
      );
      if (element === null) throw new Error('editor not shown');
      return element;
    });
    expect(form.querySelector('[data-arg-row][data-bypass="true"]')).not.toBeNull();
    expect(form.querySelector('[data-arg-row][data-invalid="true"]')).not.toBeNull();
  });
});
