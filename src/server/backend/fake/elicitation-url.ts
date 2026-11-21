/**
 * Synthetic engine scenario (WP-112, ADR-256): an MCP tool asks the user to open a URL (mode `url`,
 * `fake.parallel` – the request stays open while the stream goes on); the server then reports
 * `system/elicitation_complete` for its `elicitationId`, which closes the card (the SDK gets
 * `accept`). Then the tool result and the end of the turn.
 */
import type { FixtureEvent } from '../fixture';
import {
  closeGate,
  dslContext,
  elicitationComplete,
  elicitationStep,
  expectElicitation,
  input,
  events as join,
  streamedText,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
} from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000b2' });
const PROMPT = c.ids.uuid();
const TOOL = 'toolu_fake_elicit_url';

export const ELICITATION_URL_SERVER = 'calendar';
export const ELICITATION_URL_REQUEST_ID = 'elicit-req-url';
export const ELICITATION_URL_ID = 'elicitation-fake-url-1';
export const ELICITATION_URL = 'https://auth.example/authorize?state=fake';

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Connect my calendar'),
  turnOpen(c, PROMPT),
  toolUseBlock(c, 'mcp__calendar__connect', {}, { toolUseId: TOOL }),
  elicitationStep(c, {
    serverName: ELICITATION_URL_SERVER,
    message: 'Sign in to the calendar service.',
    mode: 'url',
    url: ELICITATION_URL,
    elicitationId: ELICITATION_URL_ID,
    requestId: ELICITATION_URL_REQUEST_ID,
    parallel: true,
  }),
  elicitationComplete(c, ELICITATION_URL_SERVER, ELICITATION_URL_ID),
  expectElicitation(c, ELICITATION_URL_REQUEST_ID, { action: 'accept' }),
  toolResultMessage(c, TOOL, 'Calendar connected.'),
  streamedText(c, 'Your calendar is connected.'),
  turnClose(c, PROMPT, { result: { result: 'Your calendar is connected.' } }),
  closeGate(),
);
