import { describe, expect, it } from 'vitest';
import { modelOptionSchema } from '@shared/model';
import { FAKE_MODELS } from '../backend/fake/defaults';
import { currentModelOption, toModelCatalog } from './models';

describe('toModelCatalog (F.12, R0-05)', () => {
  it('maps the recorded supportedModels answer schema-true, resolvedModel kept aside', () => {
    const catalog = toModelCatalog(FAKE_MODELS);
    expect(catalog.options.map((o) => o.value)).toEqual([
      'default',
      'opus',
      'claude-fable-5-1[1m]',
      'sonnet',
      'haiku',
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
      },
      {
        value: 'm2',
        displayName: 'm2',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsFastMode: false,
        supportsAutoMode: false,
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
