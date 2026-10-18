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
