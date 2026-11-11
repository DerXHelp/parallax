/**
 * Context gauge (C.1): after each turn `getContextUsage({detail:'summary'})` (no API call) →
 * `normalizeContextUsage`; during the turn an estimate from the last main-thread usage
 * (input + cache_creation + cache_read + output, signal `context_estimate`) divided by
 * rawMaxTokens resp. `modelUsage[model].contextWindow` → `estimateContextGauge`.
 * The profile override `contextWindow` (100k–1M) wins over both.
 */
import { z } from 'zod';
import type { ContextBreakdown, ContextGauge } from '@shared/model';
import type { NormalizeContextUsage, StatusSignal } from '../ports';
import { contextUsageSchema, opt } from './sdk-schemas';

type Category = ContextBreakdown['categories'][number];

/**
 * Stable SDK category ids (SDK 0.3.322 `SDKControlGetContextUsageResponse.categories[].id`) and
 * what they are. The SDK may add ids: an unknown id classifies like an absent one.
 */
const CATEGORY_KIND_BY_ID: Readonly<Record<string, Category['kind']>> = {
  system_prompt: 'used',
  system_tools: 'used',
  mcp_tools: 'used',
  mcp_instructions: 'used',
  custom_agents: 'used',
  memory_files: 'used',
  skills: 'used',
  messages: 'used',
  mcp_tools_deferred: 'deferred',
  system_tools_deferred: 'deferred',
  autocompact_buffer: 'buffer',
  compact_buffer: 'buffer',
  free_space: 'free',
};

/** Longest id passed through; longer values are not ids (WP-52). */
const MAX_CATEGORY_ID_CHARS = 100;

function categoryId(id: string | undefined): string | null {
  return id !== undefined && id !== '' && id.length <= MAX_CATEGORY_ID_CHARS ? id : null;
}

/** Classification: known `id` first, then the SDK `kind`, then `isDeferred` (WP-52). */
function categoryKind(
  id: string | null,
  kind: string | undefined,
  isDeferred: boolean | undefined,
): Category['kind'] {
  const byId = id === null || !Object.hasOwn(CATEGORY_KIND_BY_ID, id) ? undefined : CATEGORY_KIND_BY_ID[id];
  if (byId !== undefined) return byId;
  if (kind === 'used' || kind === 'free' || kind === 'buffer' || kind === 'deferred') return kind;
  return isDeferred === true ? 'deferred' : 'used';
}

function validWindow(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.round(value)
    : null;
}

function percentage(totalTokens: number, maxTokens: number): number {
  return Math.round((totalTokens / maxTokens) * 100);
}

/**
 * Raw `getContextUsage` answer → ContextBreakdown (null if unusable). `maxTokens` =
 * override ?? rawMaxTokens ?? maxTokens; the percentage is always total/max (= the SDK's own
 * value without override). Categories keep their stable SDK `id` (absent → null) and are
 * classified by id, then by their SDK `kind` (unknown kinds: deferred/used).
 */
export const normalizeContextUsage: NormalizeContextUsage = (raw, override, at, detail) => {
  const parsed = contextUsageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const usage = parsed.data;
  const maxTokens =
    validWindow(override.contextWindow) ?? validWindow(usage.rawMaxTokens) ?? validWindow(usage.maxTokens);
  if (maxTokens === null || !Number.isFinite(usage.totalTokens) || usage.totalTokens < 0) return null;
  const totalTokens = Math.round(usage.totalTokens);
  return {
    percentage: percentage(totalTokens, maxTokens),
    totalTokens,
    maxTokens,
    source: 'sdk',
    model: usage.model ?? null,
    at: at.toISOString(),
    detail,
    categories: (usage.categories ?? []).map((c) => {
      const id = categoryId(c.id);
      return { name: c.name, tokens: c.tokens, kind: categoryKind(id, c.kind, c.isDeferred), id };
    }),
    autoCompactThreshold: usage.autoCompactThreshold ?? null,
    isAutoCompactEnabled: usage.isAutoCompactEnabled ?? null,
  };
};

export interface ContextWindowSources {
  /** Profile override (C.1). */
  override: number | null;
  /** `maxTokens` of the last ContextBreakdown (rawMaxTokens of getContextUsage). */
  lastSdkMaxTokens: number | null;
  /**
   * `modelUsage[model].contextWindow` of the last result. Default (absent or null): the
   * signal's own `contextWindow` (the normalizer fills it, R1-07).
   */
  modelContextWindow?: number | null;
}

/**
 * Gauge during the turn from a `context_estimate` signal (C.1): source 'estimate', window =
 * override ?? last getContextUsage maxTokens ?? modelUsage contextWindow; null without a window.
 */
export function estimateContextGauge(
  estimate: Extract<StatusSignal, { type: 'context_estimate' }>,
  windows: ContextWindowSources,
  at: Date,
): ContextGauge | null {
  const maxTokens =
    validWindow(windows.override) ??
    validWindow(windows.lastSdkMaxTokens) ??
    validWindow(windows.modelContextWindow ?? estimate.contextWindow);
  if (maxTokens === null || estimate.totalTokens < 0) return null;
  const totalTokens = Math.round(estimate.totalTokens);
  return {
    percentage: percentage(totalTokens, maxTokens),
    totalTokens,
    maxTokens,
    source: 'estimate',
    model: estimate.model,
    at: at.toISOString(),
  };
}

const modelUsageOnlySchema = z.looseObject({
  type: z.literal('result'),
  modelUsage: opt(z.record(z.string(), z.looseObject({ contextWindow: opt(z.number()) }))),
});

/**
 * `modelUsage[model].contextWindow` of a raw `result` message (the engine passes the raw
 * message it also pushed). Without `model` (or no entry for it) the largest window is used.
 */
export function modelContextWindow(resultMessage: unknown, model: string | null): number | null {
  const parsed = modelUsageOnlySchema.safeParse(resultMessage);
  if (!parsed.success) return null;
  const entries = parsed.data.modelUsage ?? {};
  const exact = model === null ? undefined : entries[model]?.contextWindow;
  if (exact !== undefined) return validWindow(exact);
  const windows = Object.values(entries)
    .map((e) => validWindow(e.contextWindow))
    .filter((w): w is number => w !== null);
  return windows.length === 0 ? null : Math.max(...windows);
}
