import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateLimitInfo } from '@shared/model';
import { sampleHostState, sampleProfileSummary, sampleRateLimitInfo, sampleTime } from '@shared/samples';
import { setLanguage } from '@web/i18n';
import { refreshClock } from '@web/state/clock';
import { clientStore, emptyHostRecord, resetClientStore } from '@web/state/store';
import { AccountLimits } from './AccountLimits';

const NOW = Date.parse(sampleTime());
const PROFILE = sampleProfileSummary();

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  refreshClock();
});

afterEach(() => {
  act(() => {
    setLanguage('en');
  });
  vi.useRealTimers();
  resetClientStore();
});

function setLimits(info: RateLimitInfo): void {
  clientStore.setState({
    hosts: {
      local: {
        ...emptyHostRecord('local'),
        hostState: sampleHostState({ profiles: [PROFILE], accountLimits: { [PROFILE.id]: info } }),
      },
    },
  });
}

function meters(): string[] {
  const region = document.querySelector<HTMLElement>('[data-slot="account-limits"]');
  if (region === null) return [];
  return within(region)
    .getAllByRole('meter')
    .map((meter) => meter.getAttribute('aria-label') ?? '');
}

describe('subscription limits over time (R4W-06, V3-07)', () => {
  it('a window disappears exactly at its reset; the texts name a future time or date', () => {
    setLimits(
      sampleRateLimitInfo({
        windows: {
          five_hour: { utilization: 1, resetsAt: sampleTime(60) },
          seven_day: { utilization: 0.5, resetsAt: sampleTime(3 * 86_400) },
        },
        rateLimitType: 'five_hour',
        utilization: 1,
        resetsAt: sampleTime(60),
      }),
    );
    render(<AccountLimits />);
    expect(meters()).toEqual(['5-hour limit', 'Weekly limit']);
    expect(screen.getByText(/^Resets at /)).toBeTruthy();
    expect(screen.getByText(/^Resets on /)).toBeTruthy();
    act(() => {
      setLanguage('de');
    });
    // "Zurückgesetzt um" read like the past (V3-07).
    expect(screen.getByText(/^Reset um /)).toBeTruthy();
    expect(screen.getByText(/^Reset am /)).toBeTruthy();

    // No new rate_limit_event: the clock alone removes the 5-hour bar at its reset.
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(meters()).toEqual(['Wochenlimit']);
    act(() => {
      vi.advanceTimersByTime(3 * 86_400_000);
    });
    expect(meters()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Abo-Limits' })).toBeNull();
  });

  it('values persisted from yesterday (ADR-114) show nothing after a restart', () => {
    setLimits(
      sampleRateLimitInfo({
        windows: { five_hour: { utilization: 0.92, resetsAt: sampleTime(-20 * 3600) } },
        resetsAt: sampleTime(-20 * 3600),
      }),
    );
    render(<AccountLimits />);
    expect(screen.queryByRole('region', { name: 'Subscription limits' })).toBeNull();
  });
});
