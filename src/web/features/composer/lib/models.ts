import type { ModelOption } from '@shared/model';

/** `supportedModels()` lists the CLI default as value `default`; the contract says `null` = default. */
export const DEFAULT_MODEL_VALUE = 'default';

/** CLI alias whose row the CLI lists only while a session runs on it (WP-73; label from i18n). */
export const OPUSPLAN_VALUE = 'opusplan';

/** The option the session has chosen (`modelSetting`, F.12; null = the `default` option – the radio). */
export function currentModelOption(
  models: readonly ModelOption[] | null,
  modelSetting: string | null,
): ModelOption | null {
  if (models === null) return null;
  return models.find((model) => model.value === (modelSetting ?? DEFAULT_MODEL_VALUE)) ?? null;
}

/**
 * WP-73: the option the session RUNS on (label, effort, fast and auto mode): `modelSetting`, else the
 * model Claude's settings name (`claudeModel`, e.g. 'opusplan'), else Default. Without a model
 * setting a settings model missing from the list falls back to the Default row.
 */
export function effectiveModelOption(
  models: readonly ModelOption[] | null,
  modelSetting: string | null,
  claudeModel: string | null,
): ModelOption | null {
  if (models === null) return null;
  if (modelSetting !== null || claudeModel === null) return currentModelOption(models, modelSetting);
  return models.find((model) => model.value === claudeModel) ?? currentModelOption(models, null);
}

/**
 * An alias of the CLI (`default`, `opus`, `sonnet[1m]`, `opusplan` …) rather than a full model id
 * (`claude-opus-4-8`, also with a provider prefix like `us.anthropic.claude-…`).
 */
export function isModelAlias(value: string): boolean {
  return !/claude-/i.test(value);
}

/**
 * The picker's groups (WP-57; CLI 2.1.322 lists 14 entries): aliases first in the CLI's order, then
 * the full ids under "More models"; WP-73: the rows of Claude's `modelPicker` setting (`curated`) as
 * their own group in the CLI's order – the user's list, aliases and full ids alike.
 */
export function groupModels(models: readonly ModelOption[]): {
  aliases: ModelOption[];
  curated: ModelOption[];
  fullIds: ModelOption[];
} {
  const builtIn = models.filter((model) => !model.curated);
  return {
    aliases: builtIn.filter((model) => isModelAlias(model.value)),
    curated: models.filter((model) => model.curated),
    fullIds: builtIn.filter((model) => !isModelAlias(model.value)),
  };
}
