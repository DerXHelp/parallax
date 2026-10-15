/**
 * Normalizer (WP-12): two input adapters with identical items (A.3) and the context gauge (C.1).
 * Port: src/server/sessions/ports.ts; rules: docs/architecture.md §6; details: docs/wp/WP-12.md.
 */
import type { CreateLiveNormalizer, NormalizeContextUsage, NormalizeHistory } from '../ports';
import { normalizeContextUsage as normalizeContextUsageImpl } from './context';
import { normalizeHistory as normalizeHistoryImpl } from './history';
import { createLiveNormalizer as createLiveNormalizerImpl } from './live';

export const createLiveNormalizer: CreateLiveNormalizer = createLiveNormalizerImpl;
export const normalizeHistory: NormalizeHistory = normalizeHistoryImpl;
export const normalizeContextUsage: NormalizeContextUsage = normalizeContextUsageImpl;

export { estimateContextGauge, modelContextWindow, type ContextWindowSources } from './context';
/** Capping with blob for the engine (queue texts, decision inputs) – no second implementation (WP-13 §6 Nr. 6). */
export { capInput, capText } from './limits';
