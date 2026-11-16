import type { TranscriptItem } from '@shared/model';

/** Local commands carry this model name (F.8) – never a real model. */
export const SYNTHETIC_MODEL = '<synthetic>';

const EMPTY: readonly string[] = Object.freeze([]);
const cache = new WeakMap<readonly TranscriptItem[], ReadonlyMap<string, readonly string[]>>();

/**
 * WP-74 (ADR-202): the models that answered in each turn, keyed by the turn's `turn_result` id –
 * the distinct `model` of the main agent's answers, thoughts and tool calls since the previous
 * `turn_result`, in order of first appearance (`opusplan`: `claude-opus-… → claude-sonnet-…`).
 * Subagent items (`parentToolUseId`), local commands (`<synthetic>`) and empty values do not count.
 * Cached per items array (the store replaces it on every change).
 */
export function turnModelsById(items: readonly TranscriptItem[]): ReadonlyMap<string, readonly string[]> {
  const cached = cache.get(items);
  if (cached !== undefined) return cached;
  const result = new Map<string, readonly string[]>();
  let models: string[] = [];
  for (const item of items) {
    if (item.kind === 'turn_result') {
      result.set(item.id, models.length === 0 ? EMPTY : models);
      models = [];
      continue;
    }
    if (item.kind !== 'assistant_text' && item.kind !== 'thinking' && item.kind !== 'tool_call') continue;
    if (item.parentToolUseId !== null) continue;
    const model = item.model?.trim() ?? '';
    if (model === '' || model === SYNTHETIC_MODEL || models.includes(model)) continue;
    models.push(model);
  }
  cache.set(items, result);
  return result;
}

/** The models of one turn (`turnModelsById`); empty when unknown. */
export function turnModels(items: readonly TranscriptItem[], turnResultId: string): readonly string[] {
  return turnModelsById(items).get(turnResultId) ?? EMPTY;
}
