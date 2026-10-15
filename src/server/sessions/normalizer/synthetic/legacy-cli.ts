/**
 * Synthetic stream of an OLDER CLI (R0-29, WP-02 §9.4): no `msg_lifecycle_v1` capability, no
 * `command_lifecycle`, no `session_state_changed`. The prompt item appears with the first
 * `user_message_uuids` (status), resp. at the latest with the turn_result; init/turn_result
 * drive the status (working/idle) without session_state.
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, result, sequence, system, uuid } from './build';

const PROMPT = uuid(1000);
const PROMPT_2 = uuid(1001);

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Old CLI, first prompt'),
  init(1, { capabilities: undefined }),
  system(2, 'status', { status: 'requesting', user_message_uuids: [PROMPT] }),
  assistant(3, 'msg_syn_legacy_1', { type: 'text', text: 'First answer' }),
  result(4, { user_message_uuids: [PROMPT] }),
  input(PROMPT_2, 'Old CLI, second prompt'),
  init(5, { capabilities: undefined }),
  assistant(6, 'msg_syn_legacy_2', { type: 'text', text: 'Second answer' }),
  result(7, { user_message_uuids: undefined, user_message_uuid: undefined }),
]);
