/**
 * Synthetic engine scenario: the turn fails with `assistant.error: authentication_failed`
 * (synthetic API error message, setup error → CLAUDE_AUTH_FAILED, status `error`, C.5); the
 * process stays alive until close().
 */
import type { FixtureEvent } from '../fixture';
import { assistantErrorTurn, closeGate, dslContext, input, events as join } from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a5' });
const PROMPT = c.ids.uuid();

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Hello'),
  assistantErrorTurn(c, { prompt: PROMPT, error: 'authentication_failed' }),
  closeGate(),
);
