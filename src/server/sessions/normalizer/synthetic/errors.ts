/**
 * Synthetic stream: `assistant.error: authentication_failed` (synthetic API-error message) with
 * an is_error result, then a second process start that fails with `startup_failure_reason`
 * (zeroed error_during_execution result, C.5).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { assistant, init, input, lifecycle, result, sequence, state, uuid } from './build';

const PROMPT = uuid(700);
const PROMPT_2 = uuid(701);

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Hello'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  assistant(
    4,
    'syn-api-error-1',
    { type: 'text', text: 'Invalid API key · Please run /login' },
    { error: 'authentication_failed' },
    '<synthetic>',
  ),
  result(5, { is_error: true, result: 'Invalid API key · Please run /login', api_error_status: 401, num_turns: 1 }),
  lifecycle(6, PROMPT, 'completed'),
  state(7, 'idle'),
  input(PROMPT_2, 'Again'),
  result(8, {
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    duration_ms: 0,
    duration_api_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {},
    errors: ['Claude Code on Windows requires git-bash or PowerShell'],
    startup_failure_reason: 'shell_tool_missing',
    terminal_reason: undefined,
    result: undefined,
  }),
]);
