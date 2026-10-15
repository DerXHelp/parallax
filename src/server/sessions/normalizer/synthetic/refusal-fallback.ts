/**
 * Synthetic stream: model refusal fallback – the refused partial is retracted (`item.remove`),
 * the turn is retried on the fallback model; an assistant `supersedes` list; a refusal without
 * fallback becomes an error item (MODEL_REFUSAL).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, result, sequence, state, system, uuid } from './build';

const PROMPT = uuid(500);

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Explain the exploit'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3, { model: 'claude-opus-5-5' }),
  assistant(4, 'msg_syn_refused_1', { type: 'text', text: 'I can' }, {}, 'claude-opus-5-5'),
  system(5, 'model_refusal_fallback', {
    trigger: 'refusal',
    direction: 'retry',
    scope: 'session',
    original_model: 'claude-opus-5-5',
    fallback_model: 'claude-sonnet-5-5',
    request_id: null,
    retracted_message_uuids: [uuid(4)],
    content: 'Switched to Sonnet 5.5 after a refusal',
  }),
  assistant(6, 'msg_syn_refused_2', { type: 'text', text: 'Here is a safe overview.' }, {}, 'claude-sonnet-5-5'),
  assistant(7, 'msg_syn_refused_3', { type: 'text', text: 'Corrected overview.' }, { supersedes: [uuid(6)] }, 'claude-sonnet-5-5'),
  system(8, 'model_refusal_no_fallback', { original_model: 'claude-sonnet-5-5', request_id: null, content: 'Refused' }),
  result(9),
  lifecycle(10, PROMPT, 'completed'),
  state(11, 'idle'),
]);
