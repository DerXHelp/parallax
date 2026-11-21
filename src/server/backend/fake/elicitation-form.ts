/**
 * Synthetic engine scenario (WP-112, ADR-256): an MCP tool asks for a form through onElicitation
 * (`requestedSchema` with string, integer, titled enum and boolean fields) – the turn waits until the
 * card is answered; the recorded answer is accept with the content below. Then the tool result and
 * the end of the turn.
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

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000b1' });
const PROMPT = c.ids.uuid();
const TOOL = 'toolu_fake_elicit_form';

export const ELICITATION_FORM_SERVER = 'booking';
export const ELICITATION_FORM_REQUEST_ID = 'elicit-req-form';
/** The answer the scenario expects (and the tests send). */
export const ELICITATION_FORM_CONTENT = { name: 'Ada Example', guests: 2, time: '19:00', vegetarian: true };

export const ELICITATION_FORM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Name', minLength: 1, maxLength: 80 },
    guests: { type: 'integer', title: 'Guests', minimum: 1, maximum: 12, default: 2 },
    time: {
      type: 'string',
      title: 'Time',
      oneOf: [
        { const: '18:00', title: '6 pm' },
        { const: '19:00', title: '7 pm' },
      ],
    },
    vegetarian: { type: 'boolean', title: 'Vegetarian menu', default: false },
  },
  required: ['name', 'guests'],
};

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Book a table for tonight'),
  turnOpen(c, PROMPT),
  toolUseBlock(c, 'mcp__booking__reserve', { restaurant: 'Fake Bistro' }, { toolUseId: TOOL }),
  elicitationStep(c, {
    serverName: ELICITATION_FORM_SERVER,
    message: 'Please enter the reservation details.',
    mode: 'form',
    requestedSchema: ELICITATION_FORM_SCHEMA,
    requestId: ELICITATION_FORM_REQUEST_ID,
    result: { action: 'accept', content: ELICITATION_FORM_CONTENT },
  }),
  toolResultMessage(c, TOOL, 'Reserved a table for 2 at 19:00.'),
  streamedText(c, 'Your table is booked.'),
  turnClose(c, PROMPT, { result: { result: 'Your table is booked.' } }),
  closeGate(),
);
