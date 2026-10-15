/**
 * Synthetic engine scenario: the start fails with `startup_failure_reason
 * session_held_by_background` (the conversation runs in a console, R0-26) → SESSION_HELD_ELSEWHERE,
 * then the process ends (code 1). No auto-retry.
 */
import type { FixtureEvent } from '../fixture';
import { crash, dslContext, input, events as join, startupFailure } from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a4' });
const PROMPT = c.ids.uuid();

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Continue the work'),
  startupFailure(c, { reason: 'session_held_by_background', prompt: PROMPT }),
  crash(1),
);
