import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileSummary, RateLimitInfo } from '@shared/model';
import {
  sampleHostState,
  sampleId,
  sampleProfileSummary,
  sampleRateLimitInfo,
  sampleTime,
} from '@shared/samples';
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

describe('one block per account (WP41-05)', () => {
  const PLAIN = sampleProfileSummary({
    id: sampleId('pf', 1),
    name: 'Plain',
    color: 'green',
    isDefault: false,
    builtin: false,
  });
  const WORK = sampleProfileSummary({
    id: sampleId('pf', 2),
    name: 'Work',
    color: 'blue',
    isDefault: false,
    builtin: false,
    configDir: 'C:\\Users\\user\\.claude-work',
  });
  const WORK_FAST = sampleProfileSummary({
    id: sampleId('pf', 3),
    name: 'Work fast',
    color: 'teal',
    isDefault: false,
    builtin: false,
    // The same folder in another spelling (Windows: case-insensitive, either separator).
    configDir: 'c:/users/USER/.claude-work/',
  });
  const PRIVATE = sampleProfileSummary({
    id: sampleId('pf', 4),
    name: 'Private',
    color: 'pink',
    isDefault: false,
    builtin: false,
    configDir: 'C:\\Users\\user\\.claude-private',
  });

  /** A report of the 5-hour window, `seconds` after the sample time. */
  function report(utilization: number, seconds: number): RateLimitInfo {
    return sampleRateLimitInfo({
      windows: { five_hour: { utilization, resetsAt: sampleTime(3600) } },
      utilization,
      at: sampleTime(seconds),
    });
  }

  function setHost(profiles: ProfileSummary[], accountLimits: Record<string, RateLimitInfo>): void {
    clientStore.setState({
      hosts: {
        local: { ...emptyHostRecord('local'), hostState: sampleHostState({ profiles, accountLimits }) },
      },
    });
  }

  function values(): string[] {
    const region = document.querySelector<HTMLElement>('[data-slot="account-limits"]');
    if (region === null) return [];
    return within(region)
      .getAllByRole('meter')
      .map((meter) => meter.getAttribute('aria-valuenow') ?? '');
  }

  it('two profiles on the default folder are one account: one block, the newest report', () => {
    setHost([PROFILE, PLAIN], { [PROFILE.id]: report(0.03, -60), [PLAIN.id]: report(0.05, 0) });
    render(<AccountLimits />);
    expect(meters()).toEqual(['5-hour limit']);
    expect(values()).toEqual(['5']);
    // One account: no name above the bars (as with a single profile).
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('several accounts: one block each, named after all profiles of the account', () => {
    setHost([PROFILE, WORK, WORK_FAST, PRIVATE], {
      [WORK.id]: report(0.2, -30),
      [WORK_FAST.id]: report(0.25, 0),
      [PRIVATE.id]: report(0.6, 0),
    });
    render(<AccountLimits />);
    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Profiles Work, Work fast',
      'Profile Private',
    ]);
    expect(groups[0]?.textContent).toContain('Work, Work fast');
    expect(
      within(groups[0] ?? document.body)
        .getByRole('meter')
        .getAttribute('aria-valuenow'),
    ).toBe('25');
    expect(
      within(groups[1] ?? document.body)
        .getByRole('meter')
        .getAttribute('aria-valuenow'),
    ).toBe('60');
    // The standard profile has not reported: its account shows nothing.
    expect(values()).toEqual(['25', '60']);
    act(() => {
      setLanguage('de');
    });
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Profile Work, Work fast',
      'Profil Private',
    ]);
  });
});
