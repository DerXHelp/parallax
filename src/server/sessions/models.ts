/**
 * `supportedModels()` → `ModelOption[]` (WP-13 §3.5.3/§3.5.6, F.12), tolerant (R0-05): entries
 * without a usable `value` are skipped, unknown effort levels of a newer CLI dropped
 * (`parseEffortLevels`), missing flags become false. `resolved` keeps the SDK's `resolvedModel`
 * per value, so the engine can match the actual model (`assistant.message.model`) to its row.
 * WP-73: `withClaudeSettings` marks the rows of Claude's `modelPicker` and keeps tail rows (ADR-200).
 */
import { z } from 'zod';
import { parseEffortLevels } from '@shared/common';
import type { ModelOption } from '@shared/model';
import type { ClaudeModelPicker } from '../backend/types';

export interface ModelCatalog {
  options: ModelOption[];
  /** value → resolvedModel (e.g. 'haiku' → 'claude-haiku-5-5'). */
  resolved: Record<string, string>;
  /** Entries that could not be read. */
  skipped: number;
}

const flag = z.boolean().optional().catch(undefined);

const modelInfoSchema = z.looseObject({
  value: z.string().min(1),
  resolvedModel: z.string().min(1).optional().catch(undefined),
  displayName: z.string().optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  supportsEffort: flag,
  supportedEffortLevels: z.array(z.unknown()).optional().catch(undefined),
  supportsFastMode: flag,
  supportsAutoMode: flag,
});

export function toModelCatalog(raw: unknown): ModelCatalog {
  const list = z.array(z.unknown()).safeParse(raw);
  const catalog: ModelCatalog = { options: [], resolved: {}, skipped: 0 };
  if (!list.success) return catalog;
  const seen = new Set<string>();
  for (const item of list.data) {
    const parsed = modelInfoSchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.value)) {
      catalog.skipped += 1;
      continue;
    }
    const m = parsed.data;
    seen.add(m.value);
    catalog.options.push({
      value: m.value,
      displayName: m.displayName ?? m.value,
      description: m.description ?? '',
      supportsEffort: m.supportsEffort ?? false,
      supportedEffortLevels: parseEffortLevels(m.supportedEffortLevels ?? []),
      supportsFastMode: m.supportsFastMode ?? false,
      supportsAutoMode: m.supportsAutoMode ?? false,
      curated: false,
    });
    if (m.resolvedModel !== undefined) catalog.resolved[m.value] = m.resolvedModel;
  }
  return catalog;
}

function aliasOption(value: string, displayName: string): ModelOption {
  return {
    value,
    displayName,
    description: '',
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsFastMode: false,
    supportsAutoMode: false,
    curated: false,
  };
}

/**
 * WP22-01: before the first start of a profile there is no `supportedModels()` catalog – the
 * picker offers the CLI's model aliases instead (`--model default|opus|sonnet|haiku`), so the very
 * first turn can already run on the chosen model (`session.setModel` on a dormant entry is kept as
 * `modelSetting` and passed at the start). Replaced by the real catalog once a process answered.
 */
export const FALLBACK_MODEL_CATALOG: Readonly<ModelCatalog> = Object.freeze({
  options: [
    aliasOption('default', 'Default'),
    aliasOption('opus', 'Opus'),
    aliasOption('sonnet', 'Sonnet'),
    aliasOption('haiku', 'Haiku'),
  ],
  resolved: {},
  skipped: 0,
});

/**
 * WP-73 (ADR-200): a fresh `supportedModels()` catalog with Claude's settings applied.
 * - `picker` (settings `modelPicker`; null = none, undefined = unknown): rows whose value it names
 *   are `curated`; while unknown, the flags of the previous catalog stay.
 * - Tail rows: the CLI lists a row for a session's current model (e.g. 'opusplan') only in THAT
 *   session's answer. A value of `keep` (the reading entry's modelSetting/claudeModel) that the new
 *   list lacks but the previous catalog of the profile had is appended from there, so one session
 *   pinned to another model does not take the row away from the others.
 */
export function withClaudeSettings(
  catalog: ModelCatalog,
  picker: ClaudeModelPicker | null | undefined,
  previous: Pick<ModelCatalog, 'options' | 'resolved'> | null,
  keep: readonly (string | null)[],
): ModelCatalog {
  const wasCurated = new Set(previous?.options.filter((o) => o.curated).map((o) => o.value) ?? []);
  const isCurated = (value: string): boolean =>
    picker === undefined ? wasCurated.has(value) : (picker?.models.includes(value) ?? false);
  const options = catalog.options.map((o) => ({ ...o, curated: isCurated(o.value) }));
  const resolved = { ...catalog.resolved };
  for (const value of keep) {
    if (value === null || options.some((o) => o.value === value)) continue;
    const row = previous?.options.find((o) => o.value === value);
    if (row === undefined) continue;
    options.push({ ...row, curated: isCurated(row.value) });
    const target = previous?.resolved[value];
    if (target !== undefined) resolved[value] = target;
  }
  return { options, resolved, skipped: catalog.skipped };
}

/** The profile's catalog, or the alias fallback while it has none (WP22-01). */
export function catalogOrFallback(catalog: ModelCatalog | null): ModelCatalog {
  return catalog ?? { ...FALLBACK_MODEL_CATALOG, options: [...FALLBACK_MODEL_CATALOG.options] };
}

/**
 * The row of the entry's current model: the setting (alias as given) first, then the model
 * actually seen (value or resolvedModel), then the CLI default row.
 */
export function currentModelOption(
  catalog: Pick<ModelCatalog, 'options' | 'resolved'> | null,
  modelSetting: string | null,
  lastModel: string | null,
): ModelOption | null {
  if (catalog === null) return null;
  const { options, resolved } = catalog;
  const byValue = (value: string | null) =>
    value === null ? undefined : options.find((o) => o.value === value);
  return (
    byValue(modelSetting) ??
    byValue(lastModel) ??
    (lastModel === null ? undefined : options.find((o) => resolved[o.value] === lastModel)) ??
    byValue('default') ??
    null
  );
}
