/**
 * Short model name for dense displays (Plan "Sidebar → Modell"): the family `opus`, `sonnet`,
 * `haiku` or `fable` when the id or alias contains it (`claude-opus-5-5`, `opus[1m]`,
 * `us.anthropic.claude-sonnet-…`), otherwise the custom name as given (internal models).
 */
export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export function shortModelName(model: string | null): string | null {
  if (model === null) return null;
  const trimmed = model.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  return MODEL_FAMILIES.find((family) => lower.includes(family)) ?? trimmed;
}
