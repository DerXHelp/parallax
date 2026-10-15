/**
 * Synthetic engine scenario: the process dies while a permission is open (Bash waits for the
 * user) – the engine cancels the decision with `process_exit`, the tool call becomes
 * `interrupted`, the entry `error` (CLAUDE_PROCESS_CRASHED) without auto-retry. The canUseTool
 * request is `fake.parallel` so the crash can follow while the request is still open.
 */
import type { FixtureEvent } from '../fixture';
import { crash, dslContext, input, events as join, permissionStep, toolUseBlock, turnOpen } from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a2' });
const PROMPT = c.ids.uuid();
const TOOL = 'toolu_fake_crash_awaiting';
const INPUT = { command: 'mkdir -p build', description: 'Create build folder' };

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Create the build folder'),
  turnOpen(c, PROMPT),
  toolUseBlock(c, 'Bash', INPUT, { toolUseId: TOOL }),
  permissionStep(c, {
    toolName: 'Bash',
    input: INPUT,
    toolUseId: TOOL,
    parallel: true,
    suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: INPUT.command }],
        behavior: 'allow',
        destination: 'localSettings',
      },
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    ],
  }),
  crash(1),
);
