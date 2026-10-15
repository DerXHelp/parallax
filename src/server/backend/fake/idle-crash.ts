/**
 * Synthetic engine scenario: a finished turn (idle, empty queue, no decision), then the process
 * exits with code 3 – the case for auto-retry (ADR-025: 2 s / 10 s / 30 s, at most 3).
 */
import type { FixtureEvent } from '../fixture';
import { crash, dslContext, input, events as join, textTurn } from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a3' });
const PROMPT = c.ids.uuid();

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Reply with exactly: OK'),
  textTurn(c, { prompt: PROMPT, text: 'OK', thinking: 'A short answer.' }),
  crash(3),
);
