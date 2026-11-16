import { describe, expect, it } from 'vitest';
import { modelOptionSchema } from '@shared/model';
import { FAKE_MODELS } from '../backend/fake/defaults';
import { FAKE_OPUSPLAN_ROW } from '../backend/fake/claudeSettings';
import { currentModelOption, toModelCatalog, withClaudeSettings } from './models';

describe('toModelCatalog (F.12, R0-05)', () => {
  it('maps the recorded supportedModels answer schema-true, resolvedModel kept aside', () => {
    const catalog = toModelCatalog(FAKE_MODELS);
    // FAKE_MODELS = CLI 2.1.322 (auth-probe, WP-52): aliases first, then full model ids.
    expect(catalog.options.map((o) => o.value)).toEqual([
      'default',
      'opus',
      'fable',
      'sonnet',
      'haiku',
      'claude-fable-5-1',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    for (const option of catalog.options) expect(modelOptionSchema.parse(option)).toEqual(option);
    expect(catalog.resolved.haiku).toBe('claude-haiku-5-5');
    expect(catalog.options.find((o) => o.value === 'sonnet')?.supportsFastMode).toBe(false);
    expect(catalog.skipped).toBe(0);
  });

  it('tolerant: unknown effort levels dropped, missing flags false, invalid entries and duplicates skipped', () => {
    const catalog = toModelCatalog([
      {
        value: 'm1',
        displayName: 'M1',
        description: 'd',
        supportedEffortLevels: ['low', 'turbo', 'high', 'low'],
      },
      { value: 'm1', displayName: 'dup' },
      { displayName: 'no value' },
      'junk',
      { value: 'm2', displayName: 7, supportsAutoMode: 'yes' },
    ]);
    expect(catalog.options).toEqual([
      {
        value: 'm1',
        displayName: 'M1',
        description: 'd',
        supportsEffort: false,
        supportedEffortLevels: ['low', 'high'],
        supportsFastMode: false,
        supportsAutoMode: false,
        curated: false,
      },
      {
        value: 'm2',
        displayName: 'm2',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsFastMode: false,
        supportsAutoMode: false,
        curated: false,
      },
    ]);
    expect(catalog.skipped).toBe(3);
    expect(toModelCatalog('nope')).toEqual({ options: [], resolved: {}, skipped: 0 });
  });

  it('currentModelOption: setting, then the actual model (value or resolved), then default', () => {
    const catalog = toModelCatalog(FAKE_MODELS);
    expect(currentModelOption(catalog, 'sonnet', null)?.value).toBe('sonnet');
    expect(currentModelOption(catalog, null, 'claude-haiku-5-5')?.value).toBe('haiku');
    expect(currentModelOption(catalog, 'unknown-alias', null)?.value).toBe('default');
    expect(currentModelOption(null, 'sonnet', null)).toBeNull();
    expect(currentModelOption({ options: [], resolved: {} }, null, null)).toBeNull();
  });
});

describe('withClaudeSettings (WP-73, ADR-200)', () => {
  const base = toModelCatalog([
    ...FAKE_MODELS,
    { value: 'sonnet[1m]', displayName: 'Sonnet 1M', description: '' },
  ]);
  const curated = (catalog: { options: { value: string; curated: boolean }[] }) =>
    catalog.options.filter((o) => o.curated).map((o) => o.value);

  it('marks the rows the modelPicker names; without one nothing is curated', () => {
    const picker = { models: ['sonnet[1m]', 'claude-opus-4-8', 'not-listed'], replaceBuiltIn: false };
    expect(curated(withClaudeSettings(base, picker, null, []))).toEqual(['claude-opus-4-8', 'sonnet[1m]']);
    expect(curated(withClaudeSettings(base, null, null, []))).toEqual([]);
  });

  it('unknown settings keep the flags of the previous catalog', () => {
    const previous = withClaudeSettings(base, { models: ['sonnet[1m]'], replaceBuiltIn: false }, null, []);
    expect(curated(withClaudeSettings(base, undefined, previous, []))).toEqual(['sonnet[1m]']);
    expect(curated(withClaudeSettings(base, undefined, null, []))).toEqual([]);
  });

  it("keeps the previous tail row of the reading entry's model (with its resolved model)", () => {
    const withTail = toModelCatalog([...FAKE_MODELS, FAKE_OPUSPLAN_ROW]);
    const fresh = toModelCatalog(FAKE_MODELS);
    const kept = withClaudeSettings(fresh, null, withTail, ['opus', 'opusplan']);
    expect(kept.options.at(-1)).toMatchObject({
      value: 'opusplan',
      displayName: 'Opus Plan',
      curated: false,
    });
    expect(kept.resolved.opusplan).toBe('claude-sonnet-5-5');
    expect(kept.options.filter((o) => o.value === 'opus')).toHaveLength(1);
    // Not kept: no wanted value, or the previous catalog never had the row.
    expect(
      withClaudeSettings(fresh, null, withTail, [null]).options.some((o) => o.value === 'opusplan'),
    ).toBe(false);
    expect(
      withClaudeSettings(fresh, null, fresh, ['opusplan']).options.some((o) => o.value === 'opusplan'),
    ).toBe(false);
  });
});
