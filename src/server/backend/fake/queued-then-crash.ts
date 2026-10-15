/**
 * Synthetic engine scenario: a second prompt (priority next) is `queued` while a Bash command
 * runs, then the process dies before it was `started` – the engine reports it as not delivered
 * (PROMPT_NOT_DELIVERED, never resent automatically).
 */
import type { FixtureEvent } from '../fixture';
import { msg } from '../../sessions/normalizer/synthetic/build';
import {
  crash,
  dslContext,
  frame,
  input,
  events as join,
  permissionStep,
  toEvents,
  toolUseBlock,
  turnOpen,
} from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a8' });
const FIRST = c.ids.uuid();
const SECOND = c.ids.uuid();
const TOOL = 'toolu_fake_long_build';
const INPUT = { command: 'pnpm build', description: 'Build the project' };

export const events: FixtureEvent[] = join(
  input(c, FIRST, 'Run the long build'),
  turnOpen(c, FIRST),
  toolUseBlock(c, 'Bash', INPUT, { toolUseId: TOOL }),
  permissionStep(c, { toolName: 'Bash', input: INPUT, toolUseId: TOOL }),
  input(c, SECOND, 'And then the tests'),
  toEvents([frame(c, msg({ type: 'command_lifecycle', command_uuid: SECOND, state: 'queued' }))]),
  crash(1),
);
