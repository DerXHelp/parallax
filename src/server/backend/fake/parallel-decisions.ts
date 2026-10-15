/**
 * Synthetic engine scenario: two background subagents ask for a Bash permission at the same time
 * (A.6, `fake.parallel` + `agentID`): two open decisions with a subagent requester; the answers
 * may come in any order (the `decision` events are the join points). Afterwards both agents end,
 * a second turn reports, then idle.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { FixtureEvent } from '../fixture';
import {
  assistantMessage,
  closeGate,
  dslContext,
  expectDecision,
  input,
  events as join,
  permissionStep,
  streamedText,
  subagentEnd,
  subagentLaunch,
  textBlock,
  toolResultMessage,
  toolUseContent,
  turnClose,
  turnOpen,
} from './dsl';

const c = dslContext({ sessionId: '5e550000-0000-4000-8000-0000000000a6' });
const PROMPT = c.ids.uuid();

const agents = (['a', 'b'] as const).map((name) => ({
  name,
  toolUseId: `toolu_fake_agent_${name}`,
  taskId: `task-${name}`,
  bashId: `toolu_fake_bash_${name}`,
  description: `Worker ${name}`,
  prompt: `Run step ${name}`,
  reply: `step ${name} done`,
  input: { command: `echo step-${name}`, description: `Step ${name}` },
}));

const allow = (input: Record<string, unknown>): PermissionResult => ({
  behavior: 'allow',
  updatedInput: input,
  decisionClassification: 'user_temporary',
});

export const events: FixtureEvent[] = join(
  input(c, PROMPT, 'Run both steps in parallel'),
  turnOpen(c, PROMPT),
  ...agents.map((a) => subagentLaunch(c, a)),
  streamedText(c, 'Two workers run in the background.'),
  turnClose(c, PROMPT, { result: { result: 'Two workers run in the background.' }, idle: false }),
  ...agents.map((a) =>
    assistantMessage(c, [toolUseContent('Bash', a.input, a.bashId)], {
      parentToolUseId: a.toolUseId,
      streamed: false,
    }),
  ),
  ...agents.map((a) =>
    permissionStep(c, {
      toolName: 'Bash',
      input: a.input,
      toolUseId: a.bashId,
      parallel: true,
      agentId: a.taskId,
    }),
  ),
  ...agents.map((a) => expectDecision(c, 'Bash', a.bashId, allow(a.input))),
  ...agents.flatMap((a) => [
    toolResultMessage(c, a.bashId, `step-${a.name}`, { parentToolUseId: a.toolUseId }),
    assistantMessage(c, [textBlock(a.reply)], { parentToolUseId: a.toolUseId }),
  ]),
  subagentEnd(c, {
    toolUseId: 'toolu_fake_agent_a',
    taskId: 'task-a',
    summary: 'step a done',
    remaining: [{ taskId: 'task-b', description: 'Worker b' }],
  }),
  subagentEnd(c, { toolUseId: 'toolu_fake_agent_b', taskId: 'task-b', summary: 'step b done' }),
  turnOpen(c, null),
  streamedText(c, 'Both workers are done.'),
  turnClose(c, null, { result: { result: 'Both workers are done.' } }),
  closeGate(),
);
