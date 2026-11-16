import { describe, expect, it } from 'vitest';
import { sampleItems } from '@shared/samples';
import { turnModels, turnModelsById } from './turn-models';

describe('turnModelsById (WP-74, ADR-202)', () => {
  const at = (order: number) => ({ id: `it-${String(order)}`, order });

  it('per turn the distinct main-agent models in order of first appearance', () => {
    const items = [
      sampleItems.userMessage(at(1)),
      sampleItems.thinking({ ...at(2), model: 'claude-opus-5-5' }),
      sampleItems.assistantText({ ...at(3), model: 'claude-opus-5-5' }),
      sampleItems.toolCall({ ...at(4), model: 'claude-sonnet-5-5' }),
      // A subagent answer and a local command do not count.
      sampleItems.assistantText({ ...at(5), model: 'claude-haiku-5-5', parentToolUseId: 'toolu_x' }),
      sampleItems.assistantText({ ...at(6), model: '<synthetic>' }),
      sampleItems.turnResult(at(7)),
      sampleItems.userMessage(at(8)),
      sampleItems.assistantText({ ...at(9), model: ' claude-sonnet-5-5 ' }),
      sampleItems.turnResult(at(10)),
      sampleItems.userMessage(at(11)),
      sampleItems.assistantText({ ...at(12), model: null }),
      sampleItems.turnResult(at(13)),
    ];
    const byId = turnModelsById(items);
    expect(byId.get('it-7')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(byId.get('it-10')).toEqual(['claude-sonnet-5-5']);
    expect(byId.get('it-13')).toEqual([]);
    expect(turnModels(items, 'it-99')).toEqual([]);
    // Cached per items array.
    expect(turnModelsById(items)).toBe(byId);
  });
});
