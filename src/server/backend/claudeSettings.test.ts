import { describe, expect, it } from 'vitest';
import { claudeSettingsOf, MODEL_PICKER_ROWS_MAX, modelPickerOf } from './claudeSettings';

const NO_ENV = {};

describe('claudeSettingsOf (WP-73)', () => {
  it('reads remoteControlAtStartup, model and the user modelPicker', () => {
    const picker = {
      options: [{ model: 'opus', label: 'Opus' }, { model: 'claude-sonnet-5-5' }, { model: 'opus' }],
      replaceBuiltInOptions: true,
    };
    expect(
      claudeSettingsOf(
        {
          effective: { remoteControlAtStartup: true, model: 'opusplan', modelPicker: picker },
          sources: [{ source: 'userSettings', settings: { model: 'opusplan', modelPicker: picker } }],
          applied: { model: 'claude-sonnet-5-5' },
        },
        NO_ENV,
      ),
    ).toEqual({
      remoteControlAtStartup: true,
      model: 'opusplan',
      modelPicker: { models: ['opus', 'claude-sonnet-5-5'], replaceBuiltIn: true },
    });
  });

  it('ANTHROPIC_MODEL: settings env before the launch env before settings model (case-insensitive)', () => {
    const answer = (env?: Record<string, unknown>) => ({ effective: { model: 'opusplan', env } });
    expect(claudeSettingsOf(answer({ anthropic_model: 'haiku' }), { ANTHROPIC_MODEL: 'sonnet' })?.model).toBe(
      'haiku',
    );
    expect(claudeSettingsOf(answer(), { Anthropic_Model: 'sonnet' })?.model).toBe('sonnet');
    expect(claudeSettingsOf(answer({ ANTHROPIC_MODEL: 42 }), NO_ENV)?.model).toBe('opusplan');
    expect(claudeSettingsOf(answer(), { ANTHROPIC_MODEL: '  ' })?.model).toBe('opusplan');
  });

  it('an invalid model name counts as not set', () => {
    expect(claudeSettingsOf({ effective: { model: 'two words' } }, NO_ENV)?.model).toBeNull();
    expect(claudeSettingsOf({ effective: { model: 7 } }, NO_ENV)?.model).toBeNull();
    expect(claudeSettingsOf({ effective: { model: ' sonnet[1m] ' } }, NO_ENV)?.model).toBe('sonnet[1m]');
  });

  it('modelPicker: the highest of managed > flag > user wins; a project picker is ignored', () => {
    const rows = (model: string) => ({ options: [{ model }] });
    const answer = {
      effective: { modelPicker: rows('from-project') },
      sources: [
        { source: 'userSettings', settings: { modelPicker: rows('user') } },
        { source: 'projectSettings', settings: { modelPicker: rows('from-project') } },
        { source: 'flagSettings', settings: { modelPicker: rows('flag') } },
      ],
    };
    expect(claudeSettingsOf(answer, NO_ENV)?.modelPicker?.models).toEqual(['flag']);
    const policy = {
      ...answer,
      sources: [...answer.sources, { source: 'policySettings', settings: { modelPicker: rows('managed') } }],
    };
    expect(claudeSettingsOf(policy, NO_ENV)?.modelPicker?.models).toEqual(['managed']);
    const projectOnly = { ...answer, sources: [answer.sources[1]] };
    expect(claudeSettingsOf(projectOnly, NO_ENV)?.modelPicker).toBeNull();
    // Without `sources` the merged value is taken.
    expect(
      claudeSettingsOf({ effective: { modelPicker: rows('opus') } }, NO_ENV)?.modelPicker?.models,
    ).toEqual(['opus']);
  });

  it('tolerant: garbage answers are null, unusable parts count as not set', () => {
    expect(claudeSettingsOf('x', NO_ENV)).toBeNull();
    expect(claudeSettingsOf(null, NO_ENV)).toBeNull();
    expect(claudeSettingsOf({}, NO_ENV)).toBeNull();
    expect(claudeSettingsOf({ effective: 'x', sources: 'y' }, NO_ENV)).toBeNull();
    expect(claudeSettingsOf({ effective: {}, sources: [null, { source: 1 }] }, NO_ENV)).toEqual({
      remoteControlAtStartup: null,
      model: null,
      modelPicker: null,
    });
  });
});

describe('modelPickerOf', () => {
  it('needs an options array with at least one usable row; replaceBuiltIn only for true', () => {
    expect(modelPickerOf(null)).toBeNull();
    expect(modelPickerOf({ options: 'opus' })).toBeNull();
    expect(modelPickerOf({ options: [] })).toBeNull();
    expect(modelPickerOf({ options: [{ label: 'x' }, { model: '' }, { model: 'a b' }] })).toBeNull();
    expect(modelPickerOf({ options: [{ model: 'opus' }], replaceBuiltInOptions: 'true' })).toEqual({
      models: ['opus'],
      replaceBuiltIn: false,
    });
  });

  it(`keeps at most ${MODEL_PICKER_ROWS_MAX} rows`, () => {
    const options = Array.from({ length: MODEL_PICKER_ROWS_MAX + 5 }, (_, i) => ({ model: `m-${i}` }));
    expect(modelPickerOf({ options })?.models).toHaveLength(MODEL_PICKER_ROWS_MAX);
  });
});
