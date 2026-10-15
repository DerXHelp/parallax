/**
 * Synthetic stream: `system/status compacting` → `compact_boundary` → status null, then an
 * `api_retry` series (two attempts, one item upserted) that ends with the next message_start.
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, messageStart, result, sequence, state, stream, system, uuid } from './build';

const PROMPT = uuid(100);
const MSG = 'msg_syn_compact_1';

export const events: FixtureEvent[] = sequence([
  input(PROMPT, '/compact'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'queued'),
  lifecycle(3, PROMPT, 'started'),
  init(4),
  system(5, 'status', { status: 'compacting' }),
  system(6, 'compact_boundary', { compact_metadata: { trigger: 'manual', pre_tokens: 160_000, post_tokens: 30_000 } }),
  system(7, 'status', { status: null }),
  system(8, 'api_retry', { attempt: 1, max_retries: 10, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' }),
  system(9, 'api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' }),
  messageStart(10, MSG),
  stream(11, MSG, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  stream(12, MSG, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Compacted.' } }),
  assistant(13, MSG, { type: 'text', text: 'Compacted.' }),
  stream(14, MSG, { type: 'content_block_stop', index: 0 }),
  stream(15, MSG, { type: 'message_stop' }),
  result(16),
  lifecycle(17, PROMPT, 'completed'),
  state(18, 'idle'),
]);
