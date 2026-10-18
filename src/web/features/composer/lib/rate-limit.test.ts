import { describe, expect, it } from 'vitest';
import { sampleStatusFacts } from '@shared/samples';
import { rateLimitBannerState } from './rate-limit';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const FUTURE = '2026-10-16T14:30:00.000Z';
const PAST = '2026-10-16T11:00:00.000Z';

describe('rateLimitBannerState (ADR-112)', () => {
  it.each([
    ['no limit', { rateLimitedUntil: null }, null],
    ['limit ahead, nothing planned', { rateLimitedUntil: FUTURE }, { kind: 'limited', until: FUTURE }],
    [
      'continue planned',
      { rateLimitedUntil: FUTURE, wakeupAt: FUTURE },
      { kind: 'scheduled', at: FUTURE, until: FUTURE },
    ],
    ['limit passed, no plan', { rateLimitedUntil: PAST }, { kind: 'expired', until: PAST }],
    [
      'limit passed, a plan in the past is no plan',
      { rateLimitedUntil: PAST, wakeupAt: PAST },
      { kind: 'expired', until: PAST },
    ],
    ['limit passed while a turn runs', { rateLimitedUntil: PAST, runState: 'working' }, null],
    [
      'limit passed, a turn ended after the reset',
      {
        rateLimitedUntil: PAST,
        lastTurn: { outcome: 'success', endedAt: '2026-10-16T11:30:00.000Z', durationMs: 1000 },
      },
      null,
    ],
    [
      'limit passed, the last turn is older',
      {
        rateLimitedUntil: PAST,
        lastTurn: { outcome: 'error', endedAt: '2026-10-16T10:00:00.000Z', durationMs: 1000 },
      },
      { kind: 'expired', until: PAST },
    ],
  ] as const)('%s', (_name, facts, expected) => {
    expect(rateLimitBannerState(sampleStatusFacts(facts), NOW)).toEqual(expected);
  });
});
