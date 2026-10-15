import { describe, expect, it } from 'vitest';
import { makeSessionKey, LOCAL_HOST_ID } from '@shared/common';
import type { StatusFacts } from '@shared/status';
import { sampleId, sampleStatusFacts, sampleSummary, sampleTime } from '@shared/samples';
import { shutdownImpact } from './impact';

const NOW = new Date(sampleTime(3600));

function entry(
  n: number,
  title: string,
  status: Partial<StatusFacts>,
  p: { archived?: boolean; at?: number } = {},
) {
  const entryId = sampleId('en', n);
  return {
    sessionKey: makeSessionKey(LOCAL_HOST_ID, entryId),
    summary: sampleSummary({
      entryId,
      title,
      archived: p.archived ?? false,
      lastActivityAt: sampleTime(p.at ?? n),
      status: sampleStatusFacts(status),
    }),
  };
}

const decisions = (d: Partial<StatusFacts['decisions']>): StatusFacts['decisions'] => ({
  permission: 0,
  question: 0,
  plan: 0,
  oldestKind: null,
  expired: 0,
  ...d,
});

describe('shutdownImpact (A.10: list working and waiting sessions)', () => {
  it('splits running sessions into working, waiting and idle; leaves stopped ones out', () => {
    const impact = shutdownImpact(
      [
        entry(1, 'working', { runState: 'working' }),
        entry(2, 'starting', { runState: 'starting' }),
        entry(3, 'background', { runState: 'idle', backgroundTasks: 1 }),
        entry(4, 'permission', {
          runState: 'working',
          decisions: decisions({ permission: 1, oldestKind: 'permission' }),
        }),
        entry(5, 'plan', { runState: 'idle', decisions: decisions({ plan: 1, oldestKind: 'plan' }) }),
        entry(6, 'idle', { runState: 'idle' }),
        entry(7, 'done', { runState: 'idle', unread: true }),
        entry(8, 'sleeping', { runState: 'sleeping' }),
        entry(9, 'needs resume', { runState: 'interrupted', decisions: decisions({ expired: 1 }) }),
        entry(10, 'error', { runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED' }),
        entry(11, 'external', { runState: 'external' }),
        entry(12, 'archived but working', { runState: 'working' }, { archived: true }),
      ],
      NOW,
    );
    expect(impact.working.map((s) => s.title).sort()).toEqual(
      ['archived but working', 'background', 'starting', 'working'].sort(),
    );
    expect(impact.waiting.map((s) => [s.title, s.kind])).toEqual([
      ['plan', 'needs-review'],
      ['permission', 'needs-permission'],
    ]);
    expect(impact.idle).toBe(2);
  });

  it('keeps the sidebar order (newest activity first within a bucket)', () => {
    const impact = shutdownImpact(
      [
        entry(1, 'older', { runState: 'working' }, { at: 10 }),
        entry(2, 'newer', { runState: 'working' }, { at: 20 }),
      ],
      NOW,
    );
    expect(impact.working.map((s) => s.title)).toEqual(['newer', 'older']);
    expect(impact.working[0]?.sessionKey).toBe(makeSessionKey(LOCAL_HOST_ID, sampleId('en', 2)));
  });

  it('is empty without running sessions', () => {
    expect(shutdownImpact([entry(1, 'sleeping', { runState: 'sleeping' })], NOW)).toEqual({
      working: [],
      waiting: [],
      idle: 0,
    });
  });
});
