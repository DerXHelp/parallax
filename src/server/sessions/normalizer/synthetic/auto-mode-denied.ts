/**
 * Synthetic stream: auto mode classifier denies a Bash call without a permission prompt
 * (`system/permission_denied`), the tool_result is an error, the result lists the denial.
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, result, sequence, state, system, toolResult, uuid } from './build';

const PROMPT = uuid(300);
const TOOL = 'toolu_syn_denied_1';

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Delete the build folder'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3, { permissionMode: 'auto' }),
  assistant(4, 'msg_syn_denied_1', {
    type: 'tool_use',
    id: TOOL,
    name: 'Bash',
    input: { command: 'rm -rf build', description: 'Delete build' },
  }),
  system(5, 'permission_denied', {
    tool_name: 'Bash',
    tool_use_id: TOOL,
    decision_reason_type: 'classifier',
    decision_reason: 'Destructive command',
    message: 'Denied by auto mode: destructive command',
  }),
  toolResult(6, TOOL, 'Denied by auto mode: destructive command', {}, true),
  assistant(7, 'msg_syn_denied_2', { type: 'text', text: 'I was not allowed to delete it.' }),
  result(8, {
    permission_denials: [{ tool_name: 'Bash', tool_use_id: TOOL, tool_input: { command: 'rm -rf build' } }],
  }),
  lifecycle(9, PROMPT, 'completed'),
  state(10, 'idle'),
]);
