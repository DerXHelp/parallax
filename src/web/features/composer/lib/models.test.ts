import { describe, expect, it } from 'vitest';
import { sampleModelOption } from '@shared/samples';
import { groupModels, isModelAlias } from './models';

describe('model groups (WP-57)', () => {
  it('aliases (default, opus, sonnet[1m] …) are not full model ids', () => {
    expect(isModelAlias('default')).toBe(true);
    expect(isModelAlias('opus')).toBe(true);
    expect(isModelAlias('sonnet[1m]')).toBe(true);
    expect(isModelAlias('claude-opus-4-8')).toBe(false);
    expect(isModelAlias('us.anthropic.claude-sonnet-4-6')).toBe(false);
  });

  it('keeps the CLI order within each group', () => {
    const values = ['default', 'claude-opus-5', 'opus', 'claude-sonnet-4-6', 'haiku'];
    const groups = groupModels(values.map((value) => sampleModelOption({ value })));
    expect(groups.aliases.map((model) => model.value)).toEqual(['default', 'opus', 'haiku']);
    expect(groups.fullIds.map((model) => model.value)).toEqual(['claude-opus-5', 'claude-sonnet-4-6']);
  });
});
