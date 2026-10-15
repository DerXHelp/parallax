/**
 * Synthetic stream: a background Agent with task_progress and a failing end, a foreground Bash
 * with tool_progress, and a task_notification without a matching tool call (system item).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, msg, result, sequence, state, system, toolResult, uuid } from './build';

const PROMPT = uuid(400);
const AGENT = 'toolu_syn_agent_1';
const BASH = 'toolu_syn_bash_1';

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Research in the background and build'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  assistant(4, 'msg_syn_tasks_1', {
    type: 'tool_use',
    id: AGENT,
    name: 'Agent',
    input: { subagent_type: 'Explore', description: 'Find usages', prompt: 'Find all usages of foo' },
  }),
  system(5, 'background_tasks_changed', {
    tasks: [{ task_id: 'task-a', task_type: 'local_agent', subagent_type: 'Explore', description: 'Find usages' }],
  }),
  system(6, 'task_started', {
    task_id: 'task-a',
    tool_use_id: AGENT,
    description: 'Find usages',
    subagent_type: 'Explore',
    is_backgrounded: true,
    task_type: 'local_agent',
  }),
  toolResult(7, AGENT, [{ type: 'text', text: 'Async agent launched successfully.' }], {
    tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'task-a' },
  }),
  system(8, 'task_progress', {
    task_id: 'task-a',
    tool_use_id: AGENT,
    description: 'Find usages',
    usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
    last_tool_name: 'Grep',
    summary: 'Searching src/',
  }),
  assistant(9, 'msg_syn_tasks_2', { type: 'tool_use', id: BASH, name: 'Bash', input: { command: 'pnpm build' } }),
  msg({ type: 'tool_progress', tool_use_id: BASH, tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 1.4, uuid: uuid(10) }),
  msg({ type: 'tool_progress', tool_use_id: BASH, tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 1.9, uuid: uuid(11) }),
  msg({ type: 'tool_progress', tool_use_id: BASH, tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 2.1, uuid: uuid(12) }),
  toolResult(13, BASH, 'built', { tool_use_result: { stdout: 'built', stderr: '', interrupted: false, isImage: false } }),
  system(14, 'task_updated', { task_id: 'task-a', patch: { status: 'failed', end_time: 1_792_051_200_000, error: 'boom' } }),
  system(15, 'task_notification', {
    task_id: 'task-a',
    tool_use_id: AGENT,
    status: 'failed',
    output_file: '',
    summary: 'Agent failed',
    usage: { total_tokens: 1500, tool_uses: 4, duration_ms: 5000 },
  }),
  system(16, 'background_tasks_changed', { tasks: [] }),
  system(17, 'task_notification', { task_id: 'task-orphan', status: 'completed', output_file: '', summary: 'Monitor done' }),
  result(18),
  lifecycle(19, PROMPT, 'completed'),
  state(20, 'idle'),
]);
