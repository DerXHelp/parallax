import { describe, expect, it } from 'vitest';
import { sampleModelOption } from '@shared/samples';
import { effectiveModelOption, groupModels, isModelAlias } from './models';

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
    expect(groups.curated).toEqual([]);
  });

  it('WP-73: curated rows (aliases and full ids) form their own group in the CLI order', () => {
    const rows = [
      sampleModelOption({ value: 'default' }),
      sampleModelOption({ value: 'claude-opus-4-8', curated: true }),
      sampleModelOption({ value: 'opus' }),
      sampleModelOption({ value: 'sonnet[1m]', curated: true }),
      sampleModelOption({ value: 'claude-sonnet-4-6' }),
    ];
    const groups = groupModels(rows);
    expect(groups.aliases.map((model) => model.value)).toEqual(['default', 'opus']);
    expect(groups.curated.map((model) => model.value)).toEqual(['claude-opus-4-8', 'sonnet[1m]']);
    expect(groups.fullIds.map((model) => model.value)).toEqual(['claude-sonnet-4-6']);
  });
});

describe('effectiveModelOption (WP-73)', () => {
  const models = ['default', 'opus', 'opusplan'].map((value) => sampleModelOption({ value }));

  it('the chosen model, else the model of the Claude settings, else Default', () => {
    expect(effectiveModelOption(models, 'opus', 'opusplan')?.value).toBe('opus');
    expect(effectiveModelOption(models, null, 'opusplan')?.value).toBe('opusplan');
    expect(effectiveModelOption(models, null, null)?.value).toBe('default');
    // Not listed: a chosen model has no row, a settings model falls back to Default.
    expect(effectiveModelOption(models, 'haiku', null)).toBeNull();
    expect(effectiveModelOption(models, null, 'haiku')?.value).toBe('default');
    expect(effectiveModelOption(null, null, 'opus')).toBeNull();
  });
});
