import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetClientStore } from '@web/state/store';
import { TooltipProvider } from '@web/ui/tooltip';
import { closeNewSession } from '../NewSessionDialog';
import { resetSidebarView } from '../navigation/sidebar-view';
import { DEMO_HOSTS } from './hosts-demo';
import { hostsDemos } from './hosts-demos';

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  cleanup();
  act(() => {
    closeNewSession();
  });
  resetClientStore();
  window.localStorage.clear();
  window.sessionStorage.clear();
  act(() => {
    resetSidebarView();
  });
});

function show(id: string): void {
  const demo = hostsDemos.find((candidate) => candidate.id === id);
  if (demo === undefined) throw new Error(`demo ${id} missing`);
  render(<TooltipProvider>{demo.render()}</TooltipProvider>);
}

describe('playground demos of several computers (WP-80)', () => {
  it('has unique ids', () => {
    const ids = hostsDemos.map((demo) => demo.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the sidebar demo groups by computer and folder', async () => {
    show('shell-hosts-sidebar');
    await waitFor(() => {
      expect(document.querySelectorAll('[data-host-group]')).toHaveLength(3);
    });
    expect(screen.getByRole('navigation', { name: 'Sessions' }).dataset.view).toBe('host-folder');
  });

  it('the unavailable demo shows grey rows and the banner of the selected session', async () => {
    show('shell-hosts-unavailable');
    await waitFor(() => {
      expect(document.querySelector('[data-slot="pane-host"]')?.getAttribute('data-availability')).toBe(
        'unreachable',
      );
    });
    expect(document.querySelectorAll('[data-host-unavailable]').length).toBeGreaterThan(0);
  });

  it('the new-session demo opens the dialog on the other computer', async () => {
    show('shell-hosts-new-session');
    await waitFor(() => {
      expect(document.querySelector('[data-slot="host-select"]')?.getAttribute('data-host-id')).toBe(
        DEMO_HOSTS.b,
      );
    });
  });

  it('the sharing demo shows the header icon with rejected attempts', async () => {
    show('shell-hosts-sharing');
    await waitFor(() => {
      expect(document.querySelector('[data-slot="multi-host-indicator"]')?.getAttribute('data-role')).toBe(
        'share',
      );
    });
    expect(document.querySelector('[data-slot="multi-host-rejected"]')?.textContent).toBe('3');
  });

  it('the settings demo renders', async () => {
    show('shell-hosts-settings');
    await screen.findByRole('navigation', { name: 'Sessions' });
  });
});
