/**
 * Auto-retry policy (WP-13 §3.5.12, A.10, ADR-025), pure: a process that crashed **while idle**
 * (`expected: false`, code CLAUDE_PROCESS_CRASHED, before the exit runState idle with an empty
 * queue and no open decision) is restarted like `session.resume` without a prompt – backoff
 * 2 s / 10 s / 30 s, at most 3 in a row. The counter resets after a successful turn or after
 * `stableMs` (5 min) of runtime. A crash during work or with a decision → `error` + "Neu starten",
 * never automatically (no repeated side effects). The manager owns the timer; every user command
 * that starts or closes the entry cancels it.
 */
import type { ErrorCode } from '@shared/errors';

export interface AutoRetryPolicy {
  /** Delay before attempt n+1 (index n); its length is the maximum number of attempts in a row. */
  delaysMs: readonly number[];
  /** A process that ran at least this long counts as stable (counter back to 0). */
  stableMs: number;
}

export const DEFAULT_AUTO_RETRY: AutoRetryPolicy = {
  delaysMs: [2_000, 10_000, 30_000],
  stableMs: 300_000,
};

export interface RetryState {
  /** Automatic restarts in a row (since the last successful turn / stable run). */
  attempts: number;
}

export const INITIAL_RETRY_STATE: RetryState = Object.freeze({ attempts: 0 });

export interface ProcessEnd {
  expected: boolean;
  /** Error code of the exit (null for an expected exit). */
  code: ErrorCode | null;
  /** runState idle, empty queue, no open decision – right before the exit. */
  idleBefore: boolean;
  /** How long the process ran (spawn → exit). */
  runtimeMs: number;
}

export type RetryDecision =
  | { retry: false; state: RetryState; reason: 'disabled' | 'not_idle_crash' | 'exhausted' }
  | { retry: true; delayMs: number; attempt: number; state: RetryState };

export function decideRetry(
  policy: AutoRetryPolicy | false,
  state: RetryState,
  end: ProcessEnd,
): RetryDecision {
  if (policy === false) return { retry: false, state, reason: 'disabled' };
  if (end.expected || end.code !== 'CLAUDE_PROCESS_CRASHED' || !end.idleBefore) {
    return { retry: false, state, reason: 'not_idle_crash' };
  }
  const attempts = end.runtimeMs >= policy.stableMs ? 0 : state.attempts;
  const delayMs = policy.delaysMs[attempts];
  if (delayMs === undefined) return { retry: false, state: { attempts }, reason: 'exhausted' };
  return { retry: true, delayMs, attempt: attempts + 1, state: { attempts: attempts + 1 } };
}

/** A successful turn ends the series. */
export function afterSuccessfulTurn(state: RetryState): RetryState {
  return state.attempts === 0 ? state : INITIAL_RETRY_STATE;
}
