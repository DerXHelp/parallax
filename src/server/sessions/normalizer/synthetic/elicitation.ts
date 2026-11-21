/**
 * Synthetic stream (WP-112, ADR-256): an MCP URL elicitation during a turn – the `elicitation`
 * event (engine side, ignored by the normalizer), then `system/elicitation_complete` for its id
 * (signal `elicitation_complete`) and a broken one without `elicitation_id` (counted as invalid).
 */
import type { FixtureEvent } from '../../../backend/fixture';
import { init, input, lifecycle, result, sequence, state, system, uuid } from './build';

const PROMPT = uuid(300);

export const events: FixtureEvent[] = sequence([
  input(PROMPT, 'Connect my calendar'),
  state(1, 'running'),
  lifecycle(2, PROMPT, 'started'),
  init(3),
  [
    'elicitation',
    {
      request: {
        serverName: 'calendar',
        message: 'Sign in to the calendar service.',
        mode: 'url',
        url: 'https://auth.example/authorize?state=synthetic',
        elicitationId: 'elicitation-synthetic-1',
      },
      requestId: 'elicit-req-synthetic',
      signalAborted: false,
    },
  ],
  system(4, 'elicitation_complete', {
    mcp_server_name: 'calendar',
    elicitation_id: 'elicitation-synthetic-1',
  }),
  system(5, 'elicitation_complete', { mcp_server_name: 'calendar' }),
  ['elicitationResult', { requestId: 'elicit-req-synthetic', result: { action: 'accept' } }],
  result(6),
  lifecycle(7, PROMPT, 'completed'),
  state(8, 'idle'),
]);
