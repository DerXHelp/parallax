/**
 * Synthetic stream for a NEWER CLI (R0-05d): unknown type and system subtype (→ system/unknown +
 * unknownCounts), known ignored types (→ ignoredCounts), a broken frame, unknown permission
 * mode / effort level (→ null + `enum/...` count) and an unknown assistant content block.
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, msg, result, sequence, state, system, uuid } from './build';

const PROMPT = uuid(800);

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Hi'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3, { permissionMode: 'turbo', effort: 'ultra' }),
  system(4, 'status', { status: null, permissionMode: 'turbo' }),
  msg({ type: 'brand_new_type', payload: { a: 1 }, uuid: uuid(5) }),
  system(6, 'brand_new_subtype', { detail: 'x' }),
  system(7, 'files_persisted', { files: [], failed: [], processed_at: '2026-10-15T08:00:00Z' }),
  msg({ type: 'tool_use_summary', summary: 'Ran 2 tools', preceding_tool_use_ids: [], uuid: uuid(8) }),
  msg({ type: 'auth_status', isAuthenticating: false, output: [], uuid: uuid(9) }),
  msg({ type: 'keep_alive' }),
  msg({ type: 'assistant', message: 'not an object', uuid: uuid(16) }),
  system(10, 'session_state_changed', { state: 'paused' }),
  assistant(11, 'msg_syn_unknown_1', { type: 'server_widget', widget: { id: 1 } }),
  lifecycle(12, PROMPT, 'deferred'),
  result(13),
  lifecycle(14, PROMPT, 'completed'),
  state(15, 'idle'),
]);
