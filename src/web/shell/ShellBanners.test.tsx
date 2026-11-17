import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID } from '@shared/common';
import { clientStore, resetClientStore, updateHost, type HostRecord } from '@web/state/store';
import { ShellBanners } from './ShellBanners';
import { FeatureSlotsProvider, type FeatureSlots } from './slots';

afterEach(() => {
  resetClientStore();
});

function FakeUpdateBanner() {
  return <div data-testid="update-banner">updated</div>;
}

const UPDATE_SLOTS: Partial<FeatureSlots> = { UpdateBanner: FakeUpdateBanner };

function renderBanners(record: Partial<HostRecord>, slots: Partial<FeatureSlots> = {}) {
  updateHost(clientStore, LOCAL_HOST_ID, () => record);
  return render(
    <FeatureSlotsProvider slots={slots}>
      <ShellBanners />
    </FeatureSlotsProvider>,
  );
}

describe('ShellBanners: restart for an update (WP-88b)', () => {
  it('shows "Parallax is restarting" as a status with a spinner, without "Retry now"', () => {
    renderBanners({ phase: 'restarting', status: 'reconnecting', everConnected: true, restartDeadline: 1 });
    const banner = screen.getByText('Parallax is restarting…').closest('[data-slot="restart-banner"]');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Switching versions. This window reconnects by itself.');
    const spinner = banner?.querySelector('[class*="animate-spin"]');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Connection lost – reconnecting…')).toBeNull();
  });

  it('a normal outage keeps its banner with "Retry now"', () => {
    renderBanners({
      phase: 'reconnecting',
      status: 'reconnecting',
      everConnected: true,
      nextAttemptAt: null,
    });
    expect(screen.getByText('Connection lost – reconnecting…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeTruthy();
    expect(document.querySelector('[data-slot="restart-banner"]')).toBeNull();
  });

  it('renders the slot UpdateBanner (the placeholder renders nothing)', () => {
    const view = renderBanners({ phase: 'open', status: 'open', everConnected: true }, UPDATE_SLOTS);
    expect(screen.getByTestId('update-banner')).toBeTruthy();
    view.unmount();
    renderBanners({ phase: 'open', status: 'open', everConnected: true });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(document.querySelector('[data-slot="banner"]')).toBeNull();
  });
});
