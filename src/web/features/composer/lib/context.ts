import type { ContextBreakdown } from '@shared/model';

/**
 * Context categories (SDK 0.3.322, WP-52 normalizer): stable ids the gauge names in the UI language;
 * any other id – and every category of an older CLI (`id: null`) – keeps the SDK's (English) name.
 */
export const CONTEXT_CATEGORY_IDS = [
  'system_prompt',
  'system_tools',
  'mcp_tools',
  'mcp_instructions',
  'custom_agents',
  'memory_files',
  'skills',
  'messages',
  'mcp_tools_deferred',
  'system_tools_deferred',
  'autocompact_buffer',
  'compact_buffer',
  'free_space',
] as const;
export type ContextCategoryId = (typeof CONTEXT_CATEGORY_IDS)[number];

type Category = ContextBreakdown['categories'][number];

/** The id when the gauge knows it, else null. */
export function knownCategoryId(id: string | null): ContextCategoryId | null {
  return CONTEXT_CATEGORY_IDS.find((known) => known === id) ?? null;
}

/** Identity of a category: its id, else kind and name as before. */
export function categoryKey(category: Category): string {
  return category.id ?? `${category.kind}:${category.name}`;
}
