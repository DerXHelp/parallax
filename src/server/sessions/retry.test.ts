import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_RETRY,
  INITIAL_RETRY_STATE,
  afterSuccessfulTurn,
  decideRetry,
  type ProcessEnd,
  type RetryState,
} from './retry';

const crash = (p: Partial<ProcessEnd> = {}): ProcessEnd => ({
  expected: false,
  code: 'CLAUDE_PROCESS_CRASHED',
  idleBefore: true,
  runtimeMs: 1_000,
  ...p,
});

describe('decideRetry (ADR-025)', () => {
  it('backoff 2 s / 10 s / 30 s, at most 3 in a row', () => {
    let state: RetryState = INITIAL_RETRY_STATE;
    const delays: (number | null)[] = [];
    for (let i = 0; i < 4; i += 1) {
      const d = decideRetry(DEFAULT_AUTO_RETRY, state, crash());
      state = d.state;
      delays.push(d.retry ? d.delayMs : null);
    }
    expect(delays).toEqual([2_000, 10_000, 30_000, null]);
    expect(state.attempts).toBe(3);
  });

  it.each<[string, Partial<ProcessEnd>]>([
    ['expected exit', { expected: true, code: null }],
    ['crash while working', { idleBefore: false }],
    ['spawn failure', { code: 'CLAUDE_SPAWN_FAILED' }],
    ['startup failure kept', { code: 'SESSION_HELD_ELSEWHERE' }],
  ])('no retry: %s', (_name, end) => {
    const d = decideRetry(DEFAULT_AUTO_RETRY, { attempts: 1 }, crash(end));
    expect(d).toMatchObject({ retry: false, reason: 'not_idle_crash', state: { attempts: 1 } });
  });

  it('disabled policy never retries', () => {
    expect(decideRetry(false, INITIAL_RETRY_STATE, crash())).toMatchObject({
      retry: false,
      reason: 'disabled',
    });
  });

  it('a stable run (≥ stableMs) resets the counter; a successful turn too', () => {
    const exhausted = { attempts: 3 };
    expect(decideRetry(DEFAULT_AUTO_RETRY, exhausted, crash())).toMatchObject({
      retry: false,
      reason: 'exhausted',
    });
    const stable = decideRetry(
      DEFAULT_AUTO_RETRY,
      exhausted,
      crash({ runtimeMs: DEFAULT_AUTO_RETRY.stableMs }),
    );
    expect(stable).toMatchObject({ retry: true, delayMs: 2_000, attempt: 1 });
    expect(afterSuccessfulTurn(exhausted)).toEqual({ attempts: 0 });
    expect(afterSuccessfulTurn(INITIAL_RETRY_STATE)).toBe(INITIAL_RETRY_STATE);
  });
});
