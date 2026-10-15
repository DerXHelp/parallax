/**
 * Status machine (WP-12): pure reducer of the status facts (port `ReduceStatus`,
 * src/server/sessions/ports.ts; rules docs/architecture.md §7, WP-02 §9.4, R0-05). The display is
 * derived elsewhere with `deriveDisplayStatus` (@shared/status) – never here.
 * Returns the SAME object when an event changes nothing (cheap no-op detection for the engine).
 */
import { isSetupError, type ErrorCode } from '@shared/errors';
import type { StatusFacts } from '@shared/status';
import type { ReduceStatus } from '../ports';

type Patch = Partial<StatusFacts>;

function sameDecisions(a: StatusFacts['decisions'], b: StatusFacts['decisions']): boolean {
  return (
    a.permission === b.permission &&
    a.question === b.question &&
    a.plan === b.plan &&
    a.oldestKind === b.oldestKind &&
    a.expired === b.expired
  );
}

function sameTurn(a: StatusFacts['lastTurn'], b: StatusFacts['lastTurn']): boolean {
  if (a === null || b === null) return a === b;
  return a.outcome === b.outcome && a.endedAt === b.endedAt && a.durationMs === b.durationMs;
}

function sameFacts(a: StatusFacts, b: StatusFacts): boolean {
  return (
    a.runState === b.runState &&
    sameDecisions(a.decisions, b.decisions) &&
    a.unread === b.unread &&
    a.backgroundTasks === b.backgroundTasks &&
    a.queuedPrompts === b.queuedPrompts &&
    a.rateLimitedUntil === b.rateLimitedUntil &&
    a.compacting === b.compacting &&
    a.retrying === b.retrying &&
    a.wakeupAt === b.wakeupAt &&
    sameTurn(a.lastTurn, b.lastTurn) &&
    a.errorCode === b.errorCode
  );
}

/** Shallow update; the input object is returned unchanged when nothing differs. */
function apply(facts: StatusFacts, patch: Patch): StatusFacts {
  const next = { ...facts, ...patch };
  return sameFacts(facts, next) ? facts : next;
}

/** runState error with a code (the only way into `error`). */
function toError(facts: StatusFacts, code: ErrorCode): StatusFacts {
  return apply(facts, { runState: 'error', errorCode: code });
}

/** No process any more: process-bound flags reset. */
const NO_PROCESS: Patch = { compacting: false, retrying: false, backgroundTasks: 0 };

function count(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** A process runs (session_state applies); after process_exit/restart a late frame changes nothing (R1-19). */
function processRunning(runState: StatusFacts['runState']): boolean {
  return runState === 'starting' || runState === 'working' || runState === 'idle' || runState === 'error';
}

export const reduceStatus: ReduceStatus = (facts, event, now, ctx) => {
  switch (event.type) {
    case 'session_state':
      if (!processRunning(facts.runState)) return facts;
      if (event.state === 'idle') {
        // "fertig" only from idle (C.5); an error of this process stays until the next turn starts.
        return facts.runState === 'error' ? facts : apply(facts, { runState: 'idle' });
      }
      return apply(facts, { runState: 'working', errorCode: null });

    case 'init':
      // Old CLI without session_state_changed: init starts every turn (C.5).
      return !ctx.sessionStateSeen && (facts.runState === 'starting' || facts.runState === 'idle')
        ? apply(facts, { runState: 'working', errorCode: null })
        : facts;

    case 'turn_result': {
      let next = facts;
      const setupError = event.error !== null && isSetupError(event.error.code);
      // A handed-off session (external) keeps its state (R1-19).
      if (event.outcome !== 'interrupted' && (event.startupFailure || setupError) && next.runState !== 'external') {
        next = toError(next, event.error?.code ?? 'CLAUDE_STARTUP_FAILED');
      }
      if (event.synthetic) return next;
      next = apply(next, {
        lastTurn: { outcome: event.outcome, endedAt: now.toISOString(), durationMs: Math.max(0, event.durationMs) },
        ...(event.outcome !== 'interrupted' && !ctx.viewedByVisibleClient ? { unread: true } : {}),
      });
      if (!ctx.sessionStateSeen && next.runState !== 'error' && next.runState !== 'external') {
        next = apply(next, { runState: 'idle' });
      }
      return next;
    }

    case 'assistant_error':
      return isSetupError(event.error.code) && facts.runState !== 'external' ? toError(facts, event.error.code) : facts;

    case 'process_starting':
      return apply(facts, { runState: 'starting', errorCode: null, ...NO_PROCESS });

    case 'process_exit':
      if (facts.runState === 'error' || facts.runState === 'external') return apply(facts, NO_PROCESS);
      if (event.expected) return apply(facts, { runState: 'sleeping', errorCode: null, ...NO_PROCESS });
      return apply(facts, {
        runState: 'error',
        errorCode: event.error?.code ?? 'CLAUDE_PROCESS_CRASHED',
        ...NO_PROCESS,
      });

    case 'server_restart': {
      const { runState } = facts;
      if (runState === 'starting' || runState === 'working') {
        return apply(facts, { runState: 'interrupted', errorCode: null, ...NO_PROCESS });
      }
      if (event.hadOpenDecisions && runState !== 'error' && runState !== 'external') {
        return apply(facts, { runState: 'interrupted', errorCode: null, ...NO_PROCESS });
      }
      if (runState === 'idle') return apply(facts, { runState: 'sleeping', ...NO_PROCESS });
      return apply(facts, NO_PROCESS);
    }

    case 'rate_limit':
      return apply(facts, { rateLimitedUntil: event.info.status === 'rejected' ? event.info.resetsAt : null });

    case 'compacting':
      return apply(facts, { compacting: event.active });

    case 'retry':
      return apply(facts, { retrying: event.active });

    case 'background_tasks':
      return apply(facts, { backgroundTasks: count(event.count) });

    case 'queue_changed':
      return apply(facts, { queuedPrompts: count(event.count) });

    case 'decisions_changed':
      return apply(facts, { decisions: event.decisions });

    case 'viewed':
      return apply(facts, { unread: false });

    case 'external':
      if (event.active) return apply(facts, { runState: 'external', errorCode: null, ...NO_PROCESS });
      return facts.runState === 'external' ? apply(facts, { runState: 'sleeping' }) : facts;

    case 'session_id':
    case 'permission_mode':
    case 'assistant_model':
    case 'context_estimate':
    case 'conversation_reset':
    case 'title_changed':
    case 'prompt_lifecycle':
    case 'mcp_servers':
      return facts;
  }
};
