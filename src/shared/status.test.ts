import { describe, expect, it } from 'vitest';
import { sampleStatusFacts } from './samples';
import {
  DISPLAY_STATUS_KINDS,
  DONE_NOTIFY_MIN_TURN_MS,
  INITIAL_STATUS_FACTS,
  canSleep,
  deriveDisplayStatus,
  notificationFor,
  statusFactsSchema,
  type DecisionCounts,
  type DisplayStatusKind,
  type NotificationKind,
  type SortBucket,
  type StatusFacts,
} from './status';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const FUTURE = '2026-10-15T09:00:00.000Z';
const PAST = '2026-10-15T07:00:00.000Z';

function facts(p: Partial<StatusFacts> = {}, decisions: Partial<DecisionCounts> = {}): StatusFacts {
  const base = sampleStatusFacts(p);
  return { ...base, decisions: { ...base.decisions, ...decisions } };
}

const turn = (durationMs: number, outcome: 'success' | 'error' | 'interrupted' = 'success') => ({
  outcome,
  endedAt: NOW.toISOString(),
  durationMs,
});

describe('INITIAL_STATUS_FACTS', () => {
  it('is valid and sleeping', () => {
    expect(statusFactsSchema.parse(INITIAL_STATUS_FACTS)).toEqual(INITIAL_STATUS_FACTS);
    expect(deriveDisplayStatus(INITIAL_STATUS_FACTS, NOW).kind).toBe('sleeping');
  });
});

describe('deriveDisplayStatus – decision table (first matching row wins)', () => {
  const rows: [string, StatusFacts, DisplayStatusKind, boolean, SortBucket][] = [
    // row 1
    ['external', facts({ runState: 'external' }), 'external', false, 4],
    [
      'external beats decisions',
      facts({ runState: 'external' }, { permission: 1, oldestKind: 'permission' }),
      'external',
      false,
      4,
    ],
    // row 2
    [
      'permission while working',
      facts({ runState: 'working' }, { permission: 1, oldestKind: 'permission' }),
      'needs-permission',
      true,
      0,
    ],
    [
      'question while idle',
      facts({ runState: 'idle' }, { question: 1, oldestKind: 'question' }),
      'needs-answer',
      true,
      0,
    ],
    [
      'plan while starting',
      facts({ runState: 'starting' }, { plan: 1, oldestKind: 'plan' }),
      'needs-review',
      true,
      0,
    ],
    [
      'oldest kind wins',
      facts({ runState: 'working' }, { permission: 2, plan: 1, oldestKind: 'plan' }),
      'needs-review',
      true,
      0,
    ],
    [
      'missing oldestKind falls back',
      facts({ runState: 'working' }, { question: 1, oldestKind: null }),
      'needs-answer',
      true,
      0,
    ],
    [
      'decision + rate limit',
      facts({ runState: 'idle', rateLimitedUntil: FUTURE }, { permission: 1, oldestKind: 'permission' }),
      'needs-permission',
      true,
      0,
    ],
    // row 4 (decision + error: inconsistent facts → error)
    ['error', facts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' }), 'error', false, 1],
    [
      'decision + error',
      facts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' }, { plan: 1, oldestKind: 'plan' }),
      'error',
      false,
      1,
    ],
    // row 3 (ADR-016): interrupted with expired cards waits for the user
    [
      'interrupted with expired decision → needs-resume',
      facts({ runState: 'interrupted' }, { expired: 1 }),
      'needs-resume',
      true,
      0,
    ],
    [
      'interrupted with expired + (inconsistent) open decisions → needs-resume',
      facts({ runState: 'interrupted' }, { expired: 2, plan: 1, oldestKind: 'plan' }),
      'needs-resume',
      true,
      0,
    ],
    [
      'expired decisions while sleeping are no attention',
      facts({ runState: 'sleeping' }, { expired: 1 }),
      'sleeping',
      false,
      4,
    ],
    [
      'expired decisions + error → error',
      facts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' }, { expired: 1 }),
      'error',
      false,
      1,
    ],
    // row 5
    ['interrupted', facts({ runState: 'interrupted' }), 'interrupted', false, 1],
    // row 6
    ['rate-limited idle', facts({ runState: 'idle', rateLimitedUntil: FUTURE }), 'rate-limited', false, 1],
    [
      'rate-limited sleeping',
      facts({ runState: 'sleeping', rateLimitedUntil: FUTURE }),
      'rate-limited',
      false,
      1,
    ],
    [
      'rate limit + working → working',
      facts({ runState: 'working', rateLimitedUntil: FUTURE }),
      'working',
      false,
      2,
    ],
    ['expired rate limit', facts({ runState: 'idle', rateLimitedUntil: PAST }), 'idle', false, 4],
    // rows 7, 8
    ['starting', facts({ runState: 'starting' }), 'starting', false, 2],
    ['working', facts({ runState: 'working' }), 'working', false, 2],
    // row 9
    ['background tasks', facts({ runState: 'idle', backgroundTasks: 1 }), 'background', false, 2],
    ['queued prompts', facts({ runState: 'idle', queuedPrompts: 2 }), 'background', false, 2],
    ['pending wakeup', facts({ runState: 'idle', wakeupAt: FUTURE }), 'background', false, 2],
    [
      'idle + background + unread',
      facts({ runState: 'idle', backgroundTasks: 1, unread: true }),
      'background',
      false,
      2,
    ],
    ['past wakeup is no background', facts({ runState: 'idle', wakeupAt: PAST }), 'idle', false, 4],
    // rows 10, 11
    ['done', facts({ runState: 'idle', unread: true }), 'done', false, 3],
    ['idle', facts({ runState: 'idle' }), 'idle', false, 4],
    // row 12 (decision + sleeping: inconsistent facts → sleeping)
    ['sleeping', facts({ runState: 'sleeping' }), 'sleeping', false, 4],
    ['sleeping + unread', facts({ runState: 'sleeping', unread: true }), 'sleeping', false, 3],
    [
      'decision + sleeping',
      facts({ runState: 'sleeping' }, { permission: 1, oldestKind: 'permission' }),
      'sleeping',
      false,
      4,
    ],
  ];

  it.each(rows)('%s', (_name, input, kind, needsAttention, sortBucket) => {
    const status = deriveDisplayStatus(input, NOW);
    expect(status.kind).toBe(kind);
    expect(status.needsAttention).toBe(needsAttention);
    expect(status.sortBucket).toBe(sortBucket);
    expect(status.unread).toBe(input.unread);
  });

  it('covers every display kind', () => {
    const seen = new Set(rows.map(([, input]) => deriveDisplayStatus(input, NOW).kind));
    expect([...seen].sort()).toEqual([...DISPLAY_STATUS_KINDS].sort());
  });

  it('passes badges and only a future rateLimitedUntil through', () => {
    const status = deriveDisplayStatus(
      facts(
        {
          runState: 'working',
          backgroundTasks: 2,
          compacting: true,
          retrying: true,
          queuedPrompts: 3,
          rateLimitedUntil: FUTURE,
        },
        { expired: 1 },
      ),
      NOW,
    );
    expect(status.badges).toEqual({
      background: true,
      compacting: true,
      retrying: true,
      queued: 3,
      expiredDecisions: 1,
    });
    expect(status.rateLimitedUntil).toBe(FUTURE);
    expect(deriveDisplayStatus(facts({ rateLimitedUntil: PAST }), NOW).rateLimitedUntil).toBeNull();
  });
});

describe('canSleep', () => {
  const rows: [string, StatusFacts, boolean][] = [
    ['plain idle', facts({ runState: 'idle' }), true],
    ['idle with past wakeup', facts({ runState: 'idle', wakeupAt: PAST }), true],
    ['working', facts({ runState: 'working' }), false],
    ['starting', facts({ runState: 'starting' }), false],
    ['already sleeping', facts({ runState: 'sleeping' }), false],
    ['handoff (external)', facts({ runState: 'external' }), false],
    ['error', facts({ runState: 'error', errorCode: 'API_ERROR' }), false],
    ['open decision', facts({ runState: 'idle' }, { permission: 1, oldestKind: 'permission' }), false],
    ['expired decision', facts({ runState: 'idle' }, { expired: 1 }), false],
    ['background task', facts({ runState: 'idle', backgroundTasks: 1 }), false],
    ['queued prompt', facts({ runState: 'idle', queuedPrompts: 1 }), false],
    ['future wakeup', facts({ runState: 'idle', wakeupAt: FUTURE }), false],
    ['compacting', facts({ runState: 'idle', compacting: true }), false],
    ['retrying', facts({ runState: 'idle', retrying: true }), false],
  ];
  it.each(rows)('%s', (_name, input, expected) => {
    expect(canSleep(input, NOW)).toBe(expected);
  });
});

describe('notificationFor', () => {
  const ctx = { minDoneTurnMs: DONE_NOTIFY_MIN_TURN_MS };
  const working = facts({ runState: 'working' });
  const permission1 = facts({ runState: 'working' }, { permission: 1, oldestKind: 'permission' });

  const rows: [string, StatusFacts, StatusFacts, NotificationKind | null][] = [
    ['new permission', working, permission1, 'permission'],
    [
      'new question',
      working,
      facts({ runState: 'working' }, { question: 1, oldestKind: 'question' }),
      'question',
    ],
    ['new plan', working, facts({ runState: 'working' }, { plan: 1, oldestKind: 'plan' }), 'plan'],
    ['same permission again → nothing', permission1, permission1, null],
    [
      'second permission → notify again',
      permission1,
      facts({ runState: 'working' }, { permission: 2, oldestKind: 'permission' }),
      'permission',
    ],
    [
      'one of two answered → nothing',
      facts({ runState: 'working' }, { permission: 2, oldestKind: 'permission' }),
      permission1,
      null,
    ],
    [
      'oldest kind changes → notify the new kind',
      facts({ runState: 'working' }, { permission: 1, plan: 1, oldestKind: 'permission' }),
      facts({ runState: 'working' }, { plan: 1, oldestKind: 'plan' }),
      'plan',
    ],
    [
      'R0-13: a question added behind an open permission → question (not the oldest kind)',
      permission1,
      facts({ runState: 'working' }, { permission: 1, question: 1, oldestKind: 'permission' }),
      'question',
    ],
    [
      'R0-13: a plan added behind an open question → plan',
      facts({ runState: 'idle' }, { question: 1, oldestKind: 'question' }),
      facts({ runState: 'idle' }, { question: 1, plan: 1, oldestKind: 'question' }),
      'plan',
    ],
    [
      'needs-resume after a restart → no notification (ADR-016)',
      facts({ runState: 'working' }, { plan: 1, oldestKind: 'plan' }),
      facts({ runState: 'interrupted' }, { expired: 1 }),
      null,
    ],
    [
      'resume from needs-resume → working → nothing',
      facts({ runState: 'interrupted' }, { expired: 1 }),
      facts({ runState: 'starting' }),
      null,
    ],
    ['long turn done', working, facts({ runState: 'idle', unread: true, lastTurn: turn(30_000) }), 'done'],
    [
      'done from background',
      facts({ runState: 'idle', backgroundTasks: 1 }),
      facts({ runState: 'idle', unread: true, lastTurn: turn(30_000) }),
      'done',
    ],
    ['short turn → no done', working, facts({ runState: 'idle', unread: true, lastTurn: turn(5_000) }), null],
    [
      'stop → idle without unread → no done',
      working,
      facts({ runState: 'idle', lastTurn: turn(30_000, 'interrupted') }),
      null,
    ],
    [
      'still background work → no done',
      working,
      facts({ runState: 'idle', backgroundTasks: 1, lastTurn: turn(30_000) }),
      null,
    ],
    ['done without lastTurn → nothing', working, facts({ runState: 'idle', unread: true }), null],
    [
      'done from idle → nothing',
      facts({ runState: 'idle' }),
      facts({ runState: 'idle', unread: true, lastTurn: turn(30_000) }),
      null,
    ],
    ['crash', working, facts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' }), 'error'],
    [
      'error stays error → nothing',
      facts({ runState: 'error', errorCode: 'API_ERROR' }),
      facts({ runState: 'error', errorCode: 'TURN_FAILED' }),
      null,
    ],
    [
      'rate limit',
      facts({ runState: 'idle' }),
      facts({ runState: 'idle', rateLimitedUntil: FUTURE }),
      'rate_limit',
    ],
    [
      'rate limit stays → nothing',
      facts({ runState: 'idle', rateLimitedUntil: FUTURE }),
      facts({ runState: 'sleeping', rateLimitedUntil: FUTURE }),
      null,
    ],
    ['working → idle (read) → nothing', working, facts({ runState: 'idle', lastTurn: turn(30_000) }), null],
    ['sleeping → starting → nothing', facts({ runState: 'sleeping' }), facts({ runState: 'starting' }), null],
  ];
  it.each(rows)('%s', (_name, prev, next, expected) => {
    expect(notificationFor(prev, next, NOW, ctx)).toBe(expected);
  });

  it('unfocused clients get done also for short turns (minDoneTurnMs 0)', () => {
    const next = facts({ runState: 'idle', unread: true, lastTurn: turn(1_000) });
    expect(notificationFor(working, next, NOW, { minDoneTurnMs: 0 })).toBe('done');
  });
});
