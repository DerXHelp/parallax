/**
 * Synthetic engine scenario: the process dies in the middle of a streamed answer (no final
 * message, no result) – exit code 1, expected:false → CLAUDE_PROCESS_CRASHED, no auto-retry.
 */
import { messageStart, stream } from '../../sessions/normalizer/synthetic/build';
import type { FixtureEvent } from '../fixture';
import { crash, dslContext, frame, input, events as join, toEvents, turnOpen } from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a1' });
const PROMPT = c.ids.uuid();
const MSG = 'msg_fake_crash_mid_turn';

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Write a long answer'),
  turnOpen(c, PROMPT),
  toEvents([
    frame(c, messageStart(0, MSG)),
    frame(
      c,
      stream(0, MSG, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ),
    frame(
      c,
      stream(0, MSG, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'The first part of ' },
      }),
    ),
    frame(
      c,
      stream(0, MSG, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'a long answer' },
      }),
    ),
  ]),
  crash(1),
);
