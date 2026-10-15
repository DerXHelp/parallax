/**
 * Synthetic stream: rate_limit_event `allowed_warning` (banner item), `rejected` (error signal
 * RATE_LIMIT_REJECTED) and `rejected` with `credits_required` (CLAUDE_BILLING = setup error).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { init, input, lifecycle, msg, sequence, state, uuid } from './build';

const PROMPT = uuid(600);
const RESET = 1_792_051_200; // seconds

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Keep going'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  msg({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: RESET,
      rateLimitType: 'five_hour',
      utilization: 0.85,
      surpassedThreshold: 0.8,
      unifiedWindows: { five_hour: { utilization: 0.85, resetsAt: RESET } },
    },
    uuid: uuid(4),
  }),
  msg({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: RESET, rateLimitType: 'five_hour', utilization: 1 },
    uuid: uuid(5),
  }),
  msg({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'overage', errorCode: 'credits_required' },
    uuid: uuid(6),
  }),
  msg({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: RESET + 3600 }, uuid: uuid(7) }),
  state(8, 'idle'),
]);
