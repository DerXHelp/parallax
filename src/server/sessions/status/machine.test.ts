/**
 * Table tests of the status machine (port rules in src/server/sessions/ports.ts, WP-02 §9.4,
 * R0-05, docs/architecture.md §7). Display checks use the shared `deriveDisplayStatus`.
 */
import { describe, expect, it } from 'vitest';
import { makeError } from '@shared/errors';
import { sampleRateLimitInfo, sampleStatusFacts, sampleTime } from '@shared/samples';
import { deriveDisplayStatus, INITIAL_STATUS_FACTS, type StatusFacts } from '@shared/status';
import type { ReduceStatusContext, StatusEvent, StatusSignal } from '../ports';
import { reduceStatus } from './machine';

const NOW = new Date(sampleTime(100));
const LIVE: ReduceStatusContext = { viewedByVisibleClient: false, sessionStateSeen: true };

function reduce(facts: StatusFacts, events: StatusEvent[], ctx: ReduceStatusContext = LIVE): StatusFacts {
  return events.reduce((f, e) => reduceStatus(f, e, NOW, ctx), facts);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function turn(p: Partial<Extract<StatusSignal, { type: 'turn_result' }>> = {}): Extract<StatusSignal, { type: 'turn_result' }> {
  return {
    type: 'turn_result',
    outcome: 'success',
    durationMs: 30_000,
    costUsdTotal: 0.01,
    error: null,
    resultExcerpt: 'OK',
    userMessageUuids: [],
    synthetic: false,
    startupFailure: false,
    ...p,
  };
}

const working = sampleStatusFacts({ runState: 'working' });
const idle = sampleStatusFacts({ runState: 'idle' });

describe('reduceStatus: session_state', () => {
  it.each([
    ['running', 'working'],
    ['requires_action', 'working'],
    ['idle', 'idle'],
  ] as const)('%s → %s', (state, runState) => {
    expect(reduce(sampleStatusFacts({ runState: 'starting' }), [{ type: 'session_state', state }]).runState).toBe(runState);
  });

  it('idle does not touch unread', () => {
    expect(reduce(sampleStatusFacts({ runState: 'working', unread: true }), [{ type: 'session_state', state: 'idle' }]).unread).toBe(true);
    expect(reduce(working, [{ type: 'session_state', state: 'idle' }]).unread).toBe(false);
  });

  it('an error of this process survives idle; the next running turn clears it', () => {
    const error = reduce(working, [{ type: 'assistant_error', error: makeError('CLAUDE_AUTH_FAILED') }]);
    expect(reduce(error, [{ type: 'session_state', state: 'idle' }])).toBe(error);
    expect(reduce(error, [{ type: 'session_state', state: 'running' }])).toMatchObject({ runState: 'working', errorCode: null });
  });

  it.each(['sleeping', 'interrupted', 'external'] as const)(
    'a late session_state after the process ended does not revive a %s session (R1-19)',
    (runState) => {
      const ended = sampleStatusFacts({ runState });
      for (const state of ['idle', 'running', 'requires_action'] as const) {
        expect(reduce(ended, [{ type: 'session_state', state }])).toBe(ended);
      }
    },
  );

  it('after process_exit a late idle frame keeps the session sleeping (R1-19)', () => {
    const exited = reduce(working, [{ type: 'process_exit', expected: true, error: null }]);
    expect(exited.runState).toBe('sleeping');
    expect(reduce(exited, [{ type: 'session_state', state: 'idle' }])).toBe(exited);
  });
});

describe('reduceStatus: external stays external (R1-19)', () => {
  const external = sampleStatusFacts({ runState: 'external' });

  it('a setup error in turn_result or assistant_error does not overwrite external', () => {
    expect(reduce(external, [{ type: 'assistant_error', error: makeError('CLAUDE_AUTH_FAILED') }])).toBe(external);
    const after = reduce(external, [turn({ outcome: 'error', startupFailure: true, error: makeError('CLAUDE_STARTUP_FAILED') })]);
    expect(after.runState).toBe('external');
    expect(after.errorCode).toBeNull();
  });
});

describe('reduceStatus: turn_result', () => {
  it('sets lastTurn and unread (C.5); "done" still needs idle', () => {
    const after = reduce(working, [turn()]);
    expect(after).toMatchObject({ runState: 'working', unread: true, lastTurn: { outcome: 'success', durationMs: 30_000, endedAt: NOW.toISOString() } });
    expect(deriveDisplayStatus(after, NOW).kind).toBe('working');
    expect(deriveDisplayStatus(reduce(after, [{ type: 'session_state', state: 'idle' }]), NOW).kind).toBe('done');
  });

  it('result → idle and idle → result give the same facts (C.5 "beliebige Reihenfolge")', () => {
    const a = reduce(working, [turn(), { type: 'session_state', state: 'idle' }]);
    const b = reduce(working, [{ type: 'session_state', state: 'idle' }, turn()]);
    expect(a).toEqual(b);
    expect(deriveDisplayStatus(b, NOW).kind).toBe('done');
  });

  it('no unread when a visible client shows the session or the turn was interrupted (user stop)', () => {
    expect(reduce(working, [turn()], { ...LIVE, viewedByVisibleClient: true }).unread).toBe(false);
    const stopped = reduce(working, [turn({ outcome: 'interrupted' }), { type: 'session_state', state: 'idle' }]);
    expect(stopped).toMatchObject({ unread: false, errorCode: null, runState: 'idle', lastTurn: { outcome: 'interrupted' } });
    expect(deriveDisplayStatus(stopped, NOW).kind).toBe('idle');
  });

  it('synthetic turns (/rename, /clear, num_turns 0) change nothing at all (R0-05b)', () => {
    const facts = deepFreeze(sampleStatusFacts({ runState: 'working' }));
    expect(reduceStatus(facts, turn({ synthetic: true }), NOW, LIVE)).toBe(facts);
    expect(reduceStatus(facts, turn({ synthetic: true }), NOW, { ...LIVE, sessionStateSeen: false })).toBe(facts);
  });

  it('startup failure → error with its code, fallback CLAUDE_STARTUP_FAILED; process_exit keeps it (R0-05a)', () => {
    const failed = reduce(sampleStatusFacts({ runState: 'starting' }), [
      turn({ outcome: 'error', synthetic: true, startupFailure: true, error: makeError('SHELL_TOOL_MISSING') }),
    ]);
    expect(failed).toMatchObject({ runState: 'error', errorCode: 'SHELL_TOOL_MISSING', lastTurn: null, unread: false });
    expect(reduce(failed, [{ type: 'process_exit', expected: false, error: null }])).toMatchObject({ runState: 'error', errorCode: 'SHELL_TOOL_MISSING' });
    expect(reduce(failed, [{ type: 'process_exit', expected: true, error: null }])).toMatchObject({ runState: 'error', errorCode: 'SHELL_TOOL_MISSING' });
    const noCode = reduce(sampleStatusFacts({ runState: 'starting' }), [turn({ outcome: 'error', startupFailure: true, synthetic: true })]);
    expect(noCode).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_STARTUP_FAILED' });
  });

  it('a setup error in the result → error (Login/Setup hint); other errors only set lastTurn', () => {
    const auth = reduce(working, [turn({ outcome: 'error', error: makeError('CLAUDE_AUTH_FAILED') })]);
    expect(auth).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_AUTH_FAILED', unread: true, lastTurn: { outcome: 'error' } });
    const api = reduce(working, [turn({ outcome: 'error', error: makeError('API_OVERLOADED') })]);
    expect(api).toMatchObject({ runState: 'working', errorCode: null, lastTurn: { outcome: 'error' } });
  });

  it('interrupted never sets an error code', () => {
    expect(reduce(working, [turn({ outcome: 'interrupted', startupFailure: true, error: makeError('CLAUDE_AUTH_FAILED') })]).errorCode).toBeNull();
  });

  it('without session_state_changed (old CLI) init → working and turn_result → idle', () => {
    const old = { viewedByVisibleClient: false, sessionStateSeen: false };
    const started = reduce(sampleStatusFacts({ runState: 'starting' }), [{ type: 'init', sessionId: 's', model: 'm', permissionMode: null, cliVersion: '1', apiKeySource: 'none', capabilities: [] }], old);
    expect(started.runState).toBe('working');
    const done = reduce(started, [turn()], old);
    expect(done).toMatchObject({ runState: 'idle', unread: true });
    expect(reduce(started, [turn({ synthetic: true })], old).runState).toBe('working');
    // With session_state seen, init and turn_result leave runState alone.
    expect(reduce(sampleStatusFacts({ runState: 'starting' }), [{ type: 'init', sessionId: 's', model: 'm', permissionMode: null, cliVersion: '1', apiKeySource: 'none', capabilities: [] }]).runState).toBe('starting');
  });
});

describe('reduceStatus: process lifecycle and errors', () => {
  it('process_starting → starting, clears error and process flags', () => {
    const before = sampleStatusFacts({ runState: 'error', errorCode: 'CLAUDE_PROCESS_CRASHED', compacting: true, retrying: true, backgroundTasks: 2 });
    expect(reduce(before, [{ type: 'process_starting' }])).toMatchObject({ runState: 'starting', errorCode: null, compacting: false, retrying: false, backgroundTasks: 0 });
  });

  it.each([
    [true, null, 'sleeping', null],
    [false, null, 'error', 'CLAUDE_PROCESS_CRASHED'],
    [false, makeError('CLAUDE_SPAWN_FAILED'), 'error', 'CLAUDE_SPAWN_FAILED'],
  ] as const)('process_exit expected=%s error=%j → %s %s', (expected, error, runState, errorCode) => {
    expect(reduce(sampleStatusFacts({ runState: 'idle', backgroundTasks: 1, unread: true }), [{ type: 'process_exit', expected, error }])).toMatchObject({
      runState,
      errorCode,
      backgroundTasks: 0,
      unread: true,
    });
  });

  it('assistant_error: setup category → error, others unchanged', () => {
    expect(reduce(working, [{ type: 'assistant_error', error: makeError('CLAUDE_BILLING') }])).toMatchObject({ runState: 'error', errorCode: 'CLAUDE_BILLING' });
    expect(reduceStatus(working, { type: 'assistant_error', error: makeError('RATE_LIMIT_REJECTED') }, NOW, LIVE)).toBe(working);
  });
});

describe('reduceStatus: server restart (A.10, R0-17)', () => {
  it.each([
    ['starting', false, 'interrupted'],
    ['working', false, 'interrupted'],
    ['idle', false, 'sleeping'],
    ['idle', true, 'interrupted'],
    ['sleeping', true, 'interrupted'],
    ['sleeping', false, 'sleeping'],
    ['error', true, 'error'],
    ['external', true, 'external'],
  ] as const)('%s, open decisions %s → %s', (runState, hadOpenDecisions, expected) => {
    const errorCode = runState === 'error' ? 'CLAUDE_PROCESS_CRASHED' : null;
    expect(reduce(sampleStatusFacts({ runState, errorCode }), [{ type: 'server_restart', hadOpenDecisions }]).runState).toBe(expected);
  });

  it('expired cards after the restart → needs-resume (ADR-016); unread is kept', () => {
    const facts = reduce(sampleStatusFacts({ runState: 'working', unread: true }), [
      { type: 'server_restart', hadOpenDecisions: true },
      { type: 'decisions_changed', decisions: { permission: 0, question: 0, plan: 0, oldestKind: null, expired: 1 } },
    ]);
    expect(deriveDisplayStatus(facts, NOW)).toMatchObject({ kind: 'needs-resume', needsAttention: true, unread: true });
  });
});

describe('reduceStatus: flags', () => {
  it('rate_limit: only rejected sets rateLimitedUntil, allowed clears it', () => {
    const rejected = reduce(idle, [{ type: 'rate_limit', info: sampleRateLimitInfo({ status: 'rejected', resetsAt: sampleTime(3600) }) }]);
    expect(rejected.rateLimitedUntil).toBe(sampleTime(3600));
    expect(deriveDisplayStatus(rejected, NOW).kind).toBe('rate-limited');
    expect(reduce(rejected, [{ type: 'rate_limit', info: sampleRateLimitInfo({ status: 'allowed_warning' }) }]).rateLimitedUntil).toBeNull();
    expect(reduceStatus(idle, { type: 'rate_limit', info: sampleRateLimitInfo({ status: 'allowed' }) }, NOW, LIVE)).toBe(idle);
  });

  it('compacting, retry, background tasks, queue, decisions, viewed', () => {
    const facts = reduce(idle, [
      { type: 'compacting', active: true },
      { type: 'retry', active: true },
      { type: 'background_tasks', count: 2 },
      { type: 'queue_changed', count: 1 },
      { type: 'decisions_changed', decisions: { permission: 1, question: 0, plan: 1, oldestKind: 'plan', expired: 0 } },
    ]);
    expect(facts).toMatchObject({ compacting: true, retrying: true, backgroundTasks: 2, queuedPrompts: 1 });
    expect(deriveDisplayStatus(facts, NOW).kind).toBe('needs-review');
    expect(reduce(sampleStatusFacts({ runState: 'idle', unread: true }), [{ type: 'viewed' }]).unread).toBe(false);
    // A.5: idle with background work is "background", never "done".
    expect(deriveDisplayStatus(reduce(idle, [{ type: 'background_tasks', count: 1 }, turn()]), NOW).kind).toBe('background');
  });

  it('external handoff: on → external, off → sleeping; session_state is ignored meanwhile', () => {
    const external = reduce(working, [{ type: 'external', active: true }]);
    expect(external.runState).toBe('external');
    expect(reduce(external, [{ type: 'session_state', state: 'running' }])).toBe(external);
    expect(reduce(external, [{ type: 'process_exit', expected: true, error: null }]).runState).toBe('external');
    expect(reduce(external, [{ type: 'external', active: false }]).runState).toBe('sleeping');
    expect(reduceStatus(idle, { type: 'external', active: false }, NOW, LIVE)).toBe(idle);
  });

  it('informational signals return the same object; inputs are never mutated', () => {
    const facts = deepFreeze(sampleStatusFacts({ runState: 'working' }));
    const neutral: StatusEvent[] = [
      { type: 'session_id', sessionId: 's' },
      { type: 'permission_mode', mode: 'plan' },
      { type: 'assistant_model', model: 'claude-haiku-5-5' },
      { type: 'context_estimate', totalTokens: 1, model: null, contextWindow: null },
      { type: 'conversation_reset', trigger: 'clear', correlationId: 'x' },
      { type: 'title_changed', title: 't' },
      { type: 'prompt_lifecycle', messageUuid: 'u', state: 'queued' },
      { type: 'mcp_servers', notApproved: [] },
      { type: 'session_state', state: 'running' },
    ];
    for (const event of neutral) expect(reduceStatus(facts, event, NOW, LIVE)).toBe(facts);
    expect(() => reduce(facts, [turn(), { type: 'process_exit', expected: false, error: null }])).not.toThrow();
  });

  it('errorCode is set exactly when runState is error', () => {
    const events: StatusEvent[] = [
      { type: 'process_starting' },
      { type: 'session_state', state: 'running' },
      { type: 'assistant_error', error: makeError('CLAUDE_AUTH_FAILED') },
      turn({ outcome: 'error', error: makeError('CLAUDE_AUTH_FAILED') }),
      { type: 'session_state', state: 'idle' },
      { type: 'session_state', state: 'running' },
      { type: 'process_exit', expected: false, error: null },
      { type: 'server_restart', hadOpenDecisions: false },
      { type: 'process_starting' },
      { type: 'process_exit', expected: true, error: null },
    ];
    let facts = INITIAL_STATUS_FACTS;
    for (const event of events) {
      facts = reduceStatus(facts, event, NOW, LIVE);
      expect(facts.errorCode !== null).toBe(facts.runState === 'error');
    }
  });
});
