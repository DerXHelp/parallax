/**
 * Synthetic engine scenario: the CLI cancels an open canUseTool request itself (signal abort) –
 * the card disappears (`cancelled{signal_aborted}`), a later answer gets
 * DECISION_ALREADY_RESOLVED; the turn ends normally.
 */
import type { FixtureEvent } from '../fixture';
import {
  closeGate,
  dslContext,
  input,
  events as join,
  permissionStep,
  streamedText,
  toEvents,
  toolResultMessage,
  toolUseBlock,
  turnClose,
  turnOpen,
} from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a7' });
const PROMPT = c.ids.uuid();
const TOOL = 'toolu_fake_abort';
const INPUT = { command: 'rm -rf build', description: 'Remove the build folder' };

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Clean the build folder'),
  turnOpen(c, PROMPT),
  toolUseBlock(c, 'Bash', INPUT, { toolUseId: TOOL }),
  permissionStep(c, { toolName: 'Bash', input: INPUT, toolUseId: TOOL, parallel: true }),
  toEvents([['abort', { source: 'canUseTool.signal', reason: 'cancelled by the CLI', toolUseID: TOOL }]]),
  toolResultMessage(c, TOOL, 'Permission request was cancelled.', { isError: true }),
  streamedText(c, 'The request was cancelled.'),
  turnClose(c, PROMPT, { result: { result: 'The request was cancelled.' } }),
  closeGate(),
);
