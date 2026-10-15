/**
 * Synthetic stream: hook_started/progress/response (one item per hook_id), informational,
 * notification, memory_recall, local_command_output, prompt_suggestion, commands_changed.
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { init, input, lifecycle, msg, result, sequence, state, system, uuid } from './build';

const PROMPT = uuid(200);

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Run the hooks'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  system(4, 'hook_started', { hook_id: 'hook-1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' }),
  system(5, 'hook_progress', {
    hook_id: 'hook-1',
    hook_name: 'PreToolUse:Bash',
    hook_event: 'PreToolUse',
    stdout: 'checking…',
    stderr: '',
    output: '',
  }),
  system(6, 'hook_response', {
    hook_id: 'hook-1',
    hook_name: 'PreToolUse:Bash',
    hook_event: 'PreToolUse',
    output: 'allowed by policy',
    stdout: 'allowed by policy',
    stderr: '',
    exit_code: 0,
    outcome: 'success',
  }),
  system(7, 'informational', { content: 'Stop hook blocked continuation', level: 'warning', prevent_continuation: true, tag: 'stop_hook' }),
  system(8, 'notification', { key: 'update', text: 'A new version is available', priority: 'low', timeout_ms: 5000 }),
  system(9, 'memory_recall', {
    mode: 'select',
    memories: [
      { path: 'D:\\work\\synthetic\\CLAUDE.md', scope: 'personal' },
      { path: 'https://example.invalid/org-memory', scope: 'organization', content: 'Use pnpm.' },
    ],
  }),
  system(10, 'local_command_output', { content: 'Total cost: $0.00' }),
  result(11),
  lifecycle(12, PROMPT, 'completed'),
  state(13, 'idle'),
  msg({ type: 'prompt_suggestion', suggestion: 'Now run the tests', uuid: uuid(14) }),
  system(15, 'commands_changed', {
    commands: [
      { name: 'clear', description: 'Clear the conversation', argumentHint: '', aliases: ['reset', 'new'], builtin: true },
      { name: 'deploy', description: 'Project skill', argumentHint: '<env>' },
    ],
  }),
]);
