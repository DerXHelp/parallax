import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@shared/common';
import { sampleItems, sampleSystemItems, sampleTime } from '@shared/samples';
import { agentIdOf } from './agent-id';

const agent = sampleItems.toolCall({ toolName: 'Agent', input: { description: 'Look around', prompt: 'x' } });
const textResult = (text: string, structured: JsonValue = null) => ({
  isError: false,
  content: [{ type: 'text' as const, text: { text, truncated: null } }],
  structured,
  structuredTruncated: null,
  at: sampleTime(5),
});

describe('agentIdOf (WP-69)', () => {
  it('the task id first, then the live result, then the agentId line of the result text', () => {
    const notification = sampleSystemItems.task_notification();
    const task = { ...notification.task, taskId: 'a655391549dc96788', taskType: 'local_agent' };
    expect(agentIdOf({ ...agent, task })).toBe('a655391549dc96788');
    expect(agentIdOf({ ...agent, result: textResult('done', { agentId: 'a1b2', status: 'completed' }) })).toBe('a1b2');
    expect(
      agentIdOf({
        ...agent,
        result: textResult('PONG\nagentId: a09720160328a4872 (internal ID - do not mention to user.)'),
      }),
    ).toBe('a09720160328a4872');
  });

  it('null without any source or for an id with path characters', () => {
    expect(agentIdOf({ ...agent, result: null })).toBeNull();
    expect(agentIdOf({ ...agent, result: textResult('PONG') })).toBeNull();
    expect(agentIdOf({ ...agent, result: textResult('x', { agentId: '..\\evil' }) })).toBeNull();
  });
});
