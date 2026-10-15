/**
 * Synthetic stream: a text block whose final assistant message carries `aborted: true`, then a
 * second message whose thinking and tool_use blocks never get a final message (stream cut by an
 * interrupt) – the result closes them (`aborted`, tool `interrupted`, parsed partial input).
 * The thinking deltas exceed LIMITS.itemTextChars and are clipped while streaming.
 */
import { LIMITS } from '@shared/common';
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, messageStart, result, sequence, state, stream, uuid } from './build';

const PROMPT = uuid(1100);
const MSG_1 = 'msg_syn_abort_1';
const MSG_2 = 'msg_syn_abort_2';
const chunk = 't'.repeat(Math.ceil(LIMITS.itemTextChars / 2));

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Count slowly'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  messageStart(4, MSG_1),
  stream(5, MSG_1, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  stream(6, MSG_1, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1, 2, ' } }),
  assistant(7, MSG_1, { type: 'text', text: '1, 2, ' }, { aborted: true }),
  stream(8, MSG_1, { type: 'message_stop' }),
  messageStart(9, MSG_2),
  stream(10, MSG_2, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  stream(11, MSG_2, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } }),
  stream(12, MSG_2, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } }),
  stream(13, MSG_2, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } }),
  stream(14, MSG_2, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '<SIGNATURE>' } }),
  stream(15, MSG_2, {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_syn_abort', name: 'Bash', input: {} },
  }),
  stream(16, MSG_2, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
  stream(17, MSG_2, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }),
  stream(18, MSG_2, { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
  stream(19, MSG_2, { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Partial' } }),
  stream(20, MSG_2, { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: {} } }),
  result(21, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', stop_reason: null }),
  lifecycle(22, PROMPT, 'cancelled'),
  state(23, 'idle'),
]);
