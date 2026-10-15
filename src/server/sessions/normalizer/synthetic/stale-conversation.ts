/**
 * Synthetic stream for R0-05f: a Bash moved to the background in conversation 1, then `/clear`
 * (conversation_reset, new session id from the next frames/init, F.7); the background task of
 * the OLD conversation finishes afterwards → no ops for the old tool_call (only counted).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import {
  assistant,
  init,
  input,
  lifecycle,
  msg,
  result,
  SESSION_ID,
  SESSION_ID_2,
  sequence,
  state,
  system,
  toolResult,
  uuid,
} from './build';

const PROMPT = uuid(1200);
const CLEAR = uuid(1201);
const TOOL = 'toolu_syn_bg_1';
const NEW_CONVERSATION = '96ce0000-0000-4000-8000-000000000001';

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Start the dev server'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  assistant(4, 'msg_syn_bg_1', {
    type: 'tool_use',
    id: TOOL,
    name: 'Bash',
    input: { command: 'pnpm dev', run_in_background: true },
  }),
  system(5, 'task_started', { task_id: 'bg-1', tool_use_id: TOOL, description: 'pnpm dev', is_backgrounded: true, task_type: 'local_bash' }),
  toolResult(6, TOOL, 'Command running in background with ID: bg-1', {
    tool_use_result: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'bg-1' },
  }),
  result(7),
  lifecycle(8, PROMPT, 'completed'),
  state(9, 'idle'),
  input(CLEAR, '/clear'),
  state(10, 'running'),
  lifecycle(11, CLEAR, 'started'),
  msg(
    {
      type: 'conversation_reset',
      new_conversation_id: NEW_CONVERSATION,
      uuid: NEW_CONVERSATION,
      trigger: 'clear',
      user_message_uuid: CLEAR,
      timestamp: '2026-10-15T08:00:05.000Z',
    },
    SESSION_ID,
  ),
  init(12, {}, SESSION_ID_2),
  result(13, { num_turns: 0, total_cost_usd: 0, result: '' }, SESSION_ID_2),
  msg({ type: 'command_lifecycle', command_uuid: CLEAR, state: 'completed', uuid: uuid(14) }, SESSION_ID_2),
  // Late frames of the OLD conversation (old session id): no ops, no session id flip-back.
  system(15, 'task_updated', { task_id: 'bg-1', patch: { status: 'completed', end_time: 1_792_051_200_000 } }),
  system(16, 'task_notification', { task_id: 'bg-1', tool_use_id: TOOL, status: 'completed', output_file: '', summary: 'done' }),
  msg({ type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: uuid(17) }, SESSION_ID_2),
]);
