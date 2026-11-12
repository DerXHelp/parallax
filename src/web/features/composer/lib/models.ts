import type { ModelOption } from '@shared/model';

/** `supportedModels()` lists the CLI default as value `default`; the contract says `null` = default. */
export const DEFAULT_MODEL_VALUE = 'default';

/** The model option the session uses (`modelSetting`, F.12; null = the `default` option). */
export function currentModelOption(
  models: readonly ModelOption[] | null,
  modelSetting: string | null,
): ModelOption | null {
  if (models === null) return null;
  return models.find((model) => model.value === (modelSetting ?? DEFAULT_MODEL_VALUE)) ?? null;
}

/**
 * An alias of the CLI (`default`, `opus`, `sonnet[1m]`, `opusplan` …) rather than a full model id
 * (`claude-opus-4-8`, also with a provider prefix like `us.anthropic.claude-…`).
 */
export function isModelAlias(value: string): boolean {
  return !/claude-/i.test(value);
}

/**
 * The picker's two groups (WP-57; CLI 2.1.322 lists 14 entries): aliases first in the CLI's order,
 * then the full ids under "More models".
 */
export function groupModels(models: readonly ModelOption[]): {
  aliases: ModelOption[];
  fullIds: ModelOption[];
} {
  return {
    aliases: models.filter((model) => isModelAlias(model.value)),
    fullIds: models.filter((model) => !isModelAlias(model.value)),
  };
}
