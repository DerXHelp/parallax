/**
 * Synthetic engine scenarios of the FakeBackend by name (R0-06: `.ts` modules in fixture format
 * v1, never `.jsonl`). The WP-12 streams (`SYNTHETIC_STREAMS`) are directly playable as well and
 * are not duplicated here.
 */
import type { FixtureEvent } from '../fixture';
import { events as abortDecision } from './abort-decision';
import { events as crashAwaitingDecision } from './crash-awaiting-decision';
import { events as crashMidTurn } from './crash-mid-turn';
import { events as idleCrash } from './idle-crash';
import { events as parallelDecisions } from './parallel-decisions';
import { events as queuedThenCrash } from './queued-then-crash';
import { events as setupAuthError } from './setup-auth-error';
import { events as startupHeldElsewhere } from './startup-held-elsewhere';

export const FAKE_SCENARIOS: Readonly<Record<string, readonly FixtureEvent[]>> = {
  'abort-decision': abortDecision,
  'crash-awaiting-decision': crashAwaitingDecision,
  'crash-mid-turn': crashMidTurn,
  'idle-crash': idleCrash,
  'parallel-decisions': parallelDecisions,
  'queued-then-crash': queuedThenCrash,
  'setup-auth-error': setupAuthError,
  'startup-held-elsewhere': startupHeldElsewhere,
};
