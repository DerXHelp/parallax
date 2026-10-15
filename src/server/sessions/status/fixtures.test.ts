/**
 * Status sequences per recorded fixture (and per synthetic stream): normalizer signals plus the
 * engine's process/decision/queue events through `reduceStatus`, displayed with the shared
 * `deriveDisplayStatus`. Expected sequences are asserted for the key scenarios; all are
 * snapshotted (__snapshots__/<scenario>.json).
 */
import { describe, expect, it } from 'vitest';
import { loadAllFixtures, replayStatus, snapshotJson, type StatusReplayOptions } from '../normalizer/testing/harness';
import { SYNTHETIC_STREAMS } from '../normalizer/synthetic/index';

const fixtures = await loadAllFixtures();

function displays(scenario: string, options: StatusReplayOptions = {}): string[] {
  const fixture = fixtures.get(scenario);
  if (fixture === undefined) throw new Error(`fixture ${scenario} missing`);
  return replayStatus(fixture, options).transitions.map((t) => t.display);
}

/** Display sequence with repeated sub-sequences of one turn collapsed for readability. */
function collapse(values: string[]): string[] {
  return values.filter((v, i) => i === 0 || v !== values[i - 1]);
}

describe.each([...fixtures.keys()])('status sequence: %s', (scenario) => {
  it('matches the snapshot', async () => {
    const fixture = fixtures.get(scenario);
    if (fixture === undefined) throw new Error(`fixture ${scenario} missing`);
    const { transitions, facts } = replayStatus(fixture);
    expect(facts.errorCode).toBeNull();
    await expect(snapshotJson({ scenario, transitions, facts })).toMatchFileSnapshot(`./__snapshots__/${scenario}.json`);
  });
});

describe('expected status sequences', () => {
  it('auth-probe: starting → working → done (unread) → sleeping (keeps unread)', () => {
    expect(displays('auth-probe')).toEqual(['sleeping', 'starting', 'working', 'working+unread', 'done+unread', 'sleeping+unread']);
  });

  it('permissions: waiting for permission between working phases, done after idle', () => {
    const seq = collapse(displays('permissions'));
    expect(seq.slice(0, 6)).toEqual(['sleeping', 'starting', 'working', 'needs-permission', 'working', 'needs-permission']);
    expect(seq).toContain('done+unread');
    expect(seq.at(-1)).toBe('sleeping+unread');
  });

  it('ask-user-question / plan-mode: the decision kind decides the waiting status', () => {
    expect(displays('ask-user-question')).toContain('needs-answer');
    const plan = displays('plan-mode');
    expect(plan.filter((d) => d === 'needs-review')).toHaveLength(2);
    expect(plan.at(-2)).toBe('done+unread');
  });

  it('interrupt: a user stop ends in idle without unread (no "done")', () => {
    const seq = displays('interrupt');
    expect(seq.slice(0, 6)).toEqual(['sleeping', 'starting', 'working', 'needs-permission', 'working', 'idle']);
  });

  it('clear-rename: /rename and /clear (synthetic turns) do not mark the session unread (R0-05b)', () => {
    // A visible client looks at the session after each idle; queued prompts show "background".
    const seq = displays('clear-rename', { viewedAfterIdle: true });
    expect(seq).toEqual([
      'sleeping',
      'starting',
      'working',
      'working+unread', // ONE: result
      'done+unread', // ONE: idle
      'idle', // viewed
      'background', // /rename sent (queued)
      'working',
      'idle', // /rename done: no unread, no "done"
      'background', // /clear sent
      'working',
      'idle', // /clear done: no unread
      'background', // TWO sent
      'working',
      'working+unread',
      'done+unread',
      'idle',
      'sleeping',
    ]);
  });

  it('subagent: background agent – idle only after the second result, then done', () => {
    const seq = displays('subagent');
    expect(seq).toEqual(['sleeping', 'starting', 'working', 'working+unread', 'done+unread', 'sleeping+unread']);
  });

  it('queue-priority: background bash after the turn → background, then working again, finally done', () => {
    const seq = collapse(displays('queue-priority'));
    expect(seq).toContain('background+unread');
    expect(seq.at(-2)).toBe('done+unread');
  });

  it('history: no live stream → stays sleeping', () => {
    expect(displays('history')).toEqual(['sleeping']);
  });
});

describe('status of synthetic streams', () => {
  const sequence = (name: string): string[] => {
    const events = SYNTHETIC_STREAMS[name];
    if (events === undefined) throw new Error(`synthetic stream ${name} missing`);
    return replayStatus({ events }).transitions.map((t) => t.display);
  };

  it('errors: auth failure → error (setup hint) survives idle; startup failure keeps its code', () => {
    const events = SYNTHETIC_STREAMS.errors;
    if (events === undefined) throw new Error('errors missing');
    const { transitions, facts } = replayStatus({ events });
    expect(transitions.map((t) => t.display)).toEqual(['sleeping', 'starting', 'working', 'error', 'error+unread']);
    expect(facts).toMatchObject({ runState: 'error', errorCode: 'SHELL_TOOL_MISSING' });
  });

  it('legacy CLI: init → working, turn_result → done (no session_state_changed)', () => {
    expect(sequence('legacy-cli')).toEqual([
      'sleeping',
      'starting',
      'working',
      'done+unread',
      'background+unread', // second prompt queued
      'working+unread',
      'done+unread',
    ]);
  });

  it('rate limits: rejected shows rate-limited once idle; credits_required is a setup error', () => {
    const events = SYNTHETIC_STREAMS['rate-limits'];
    if (events === undefined) throw new Error('rate-limits missing');
    const { facts } = replayStatus({ events });
    expect(facts).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_BILLING', rateLimitedUntil: null });
  });

  it('compact + retry: compacting/retrying badges come and go', () => {
    const events = SYNTHETIC_STREAMS['compact-retry'];
    if (events === undefined) throw new Error('compact-retry missing');
    const { facts } = replayStatus({ events });
    expect(facts).toMatchObject({ compacting: false, retrying: false, runState: 'idle', unread: true });
  });

  it.each(Object.keys(SYNTHETIC_STREAMS).sort())('%s matches the snapshot', async (name) => {
    const events = SYNTHETIC_STREAMS[name];
    if (events === undefined) throw new Error(`${name} missing`);
    await expect(snapshotJson({ name, ...replayStatus({ events }) })).toMatchFileSnapshot(`./__snapshots__/synthetic/${name}.json`);
  });
});
