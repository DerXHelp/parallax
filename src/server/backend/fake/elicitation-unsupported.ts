/**
 * Synthetic engine scenario (WP-112, ADR-256): an MCP form outside the subset Parallax renders (a
 * multi-select array field) – the decision carries `unsupported` and offers only "Decline"; the
 * recorded answer is decline. Then the tool result and the end of the turn.
 */
import type { FixtureEvent } from '../fixture';
import {
  closeGate,
  dslContext,
  elicitationStep,
  input,
  events as join,
  streamedText,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
} from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000b3' });
const PROMPT = c.ids.uuid();
const TOOL = 'toolu_fake_elicit_unsupported';

export const ELICITATION_UNSUPPORTED_SERVER = 'survey';
export const ELICITATION_UNSUPPORTED_REQUEST_ID = 'elicit-req-unsupported';

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Fill in the survey'),
  turnOpen(c, PROMPT),
  toolUseBlock(c, 'mcp__survey__start', {}, { toolUseId: TOOL }),
  elicitationStep(c, {
    serverName: ELICITATION_UNSUPPORTED_SERVER,
    message: 'Which topics interest you?',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string', enum: ['news', 'sports', 'tech'] } },
      },
    },
    requestId: ELICITATION_UNSUPPORTED_REQUEST_ID,
    result: { action: 'decline' },
  }),
  toolResultMessage(c, TOOL, 'The user declined the survey.', { isError: true }),
  streamedText(c, 'You declined the survey.'),
  turnClose(c, PROMPT, { result: { result: 'You declined the survey.' } }),
  closeGate(),
);
