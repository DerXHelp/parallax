/**
 * Synthetic stream of Remote Control (WP-64), derived from the live spike of 12.11.2026
 * (`.worktrees/_spike-rc`, CLI 2.1.322, `--replay-user-messages`):
 * - `system/bridge_state` ready → connected (with `bridge_epoch`);
 * - the echo of an own prompt: `user` isReplay with the SAME uuid (Parallax sends origin human) – dropped;
 * - a prompt typed in the Claude app: `command_lifecycle` queued/started with a foreign uuid, then
 *   `init`, then the `user` replay with `origin: {kind:'human'}` and that uuid → user_message 'remote';
 * - `task_summary` / `post_turn_summary` (only with a connected bridge; WP-65) – counted as ignored;
 * - a retrying failure (`failure_kind` other than terminal), `connected` with `recovered`, a terminal
 *   failure, an unknown state of a newer CLI and a bridge_state without `state` (invalid).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, msg, result, sequence, state, system, uuid } from './build';

const OWN = uuid(3000);
/** Foreign uuid of the prompt from the Claude app (never registered by Parallax). */
const REMOTE = '21526cdc-968c-4fb8-8b09-487aa2e4113f';

export const events: FixtureEvent[] = sequence([
  system(1, 'bridge_state', { state: 'ready' }),
  input(OWN, 'Antworte nur mit: OK (nach Neustart)'),
  state(2, 'running'),
  lifecycle(3, OWN, 'queued'),
  lifecycle(4, OWN, 'started'),
  init(5),
  system(6, 'bridge_state', { state: 'connected', bridge_epoch: 1 }),
  // Echo of the own prompt: same uuid, origin human like toSdkUserMessage sends it.
  msg({
    type: 'user',
    message: { role: 'user', content: 'Antworte nur mit: OK (nach Neustart)' },
    parent_tool_use_id: null,
    uuid: OWN,
    timestamp: '2026-10-15T08:00:00.791Z',
    isReplay: true,
    origin: { kind: 'human' },
  }),
  assistant(7, 'msg_syn_rc_1', { type: 'text', text: 'OK (nach Neustart)' }),
  system(8, 'post_turn_summary', {
    summarizes_uuid: uuid(7),
    status_category: 'completed',
    status_detail: "replied 'OK (nach Neustart)' as requested",
    needs_action: '',
  }),
  result(9, { user_message_uuids: [OWN] }),
  lifecycle(10, OWN, 'completed'),
  state(11, 'idle'),
  // Prompt typed in the Claude app.
  state(12, 'running'),
  lifecycle(13, REMOTE, 'queued'),
  lifecycle(14, REMOTE, 'started'),
  init(15),
  msg({
    type: 'user',
    message: { role: 'user', content: 'Antworte nur mit: Zweiter Test vom Handy' },
    parent_tool_use_id: null,
    uuid: REMOTE,
    timestamp: '2026-10-15T08:00:05.303Z',
    isReplay: true,
    origin: { kind: 'human' },
  }),
  system(16, 'task_summary', { detail: 'Replying to the phone test' }),
  assistant(17, 'msg_syn_rc_2', { type: 'text', text: 'Zweiter Test vom Handy' }),
  result(18, { user_message_uuids: [REMOTE], total_cost_usd: 0.002 }),
  lifecycle(19, REMOTE, 'completed'),
  system(20, 'task_summary', { detail: null }),
  state(21, 'idle'),
  // Connection trouble: retrying failure, recovered, terminal failure, newer CLI, invalid.
  system(22, 'bridge_state', { state: 'failed', detail: 'network down', failure_kind: 'transient' }),
  system(23, 'bridge_state', { state: 'connected', recovered: true, bridge_epoch: 2 }),
  system(24, 'bridge_state', { state: 'failed', detail: 'session ended elsewhere' }),
  system(25, 'bridge_state', { state: 'hibernating' }),
  system(26, 'bridge_state', { detail: 'no state' }),
]);
