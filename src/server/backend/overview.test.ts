import { describe, expect, it } from 'vitest';
import { titleOf, usageLimitsOf } from './overview';

describe('titleOf (generateSessionTitle answer)', () => {
  it.each<[unknown, string | null]>([
    ['  Login-Fehlschlag \n nach Token-Ablauf ', 'Login-Fehlschlag nach Token-Ablauf'],
    ['', null],
    [null, null],
    [{ title: 'x' }, null],
    ['x'.repeat(300), 'x'.repeat(200)],
  ])('%j → %j', (raw, expected) => {
    expect(titleOf(raw)).toBe(expected);
  });
});

describe('usageLimitsOf (usage query answer)', () => {
  it('known windows with a value (0–100 → 0–1), codename windows without one dropped, extra usage as overage', () => {
    expect(
      usageLimitsOf({
        session: { total_cost_usd: 1.2 },
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 23, resets_at: '2026-11-12T18:00:00+01:00', used_usd: 1 },
          seven_day: { utilization: 140, resets_at: 'garbage' },
          seven_day_opus: null,
          seven_day_oauth_apps: null,
          seven_day_sonnet: { utilization: null, resets_at: null },
          extra_usage: { is_enabled: true, utilization: 5 },
        },
      }),
    ).toEqual({
      windows: {
        five_hour: { utilization: 0.23, resetsAt: '2026-11-12T17:00:00.000Z' },
        seven_day: { utilization: 1, resetsAt: null },
        overage: { utilization: 0.05, resetsAt: null },
      },
      cleared: ['seven_day_opus', 'seven_day_sonnet'],
    });
  });

  it('disabled extra usage clears overage; no plan limits or an unknown shape → null', () => {
    expect(usageLimitsOf({ rate_limits: { extra_usage: { is_enabled: false, utilization: null } } })).toEqual({
      windows: {},
      cleared: ['overage'],
    });
    expect(usageLimitsOf({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(usageLimitsOf({ rate_limits: null })).toBeNull();
    expect(usageLimitsOf('nope')).toBeNull();
    expect(usageLimitsOf({ rate_limits: 'nope' })).toBeNull();
  });
});
