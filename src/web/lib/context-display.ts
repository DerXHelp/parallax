import type { ContextGauge } from '@shared/model';

/**
 * Context display of the sidebar and the session header (WP-63 §1.4, rule confirmed by the user):
 * - the FILL runs up to the autocompact: the bar is scaled to `autoCompactThreshold` when the
 *   autocompact is on and known, else to `maxTokens`;
 * - the COLOR says "the context is really full" – share of the model window
 *   (`totalTokens / maxTokens`): below 50 % neutral, from 50 % warning, from 80 % danger;
 * - "autocompact soon" is a separate channel (a symbol, never a color): from
 *   AUTOCOMPACT_SOON_RATIO of the threshold on. Both may hold at the same time.
 * Gauges without a threshold (older ones, `null`) are scaled to `maxTokens` with the same colors.
 */

/** Color thresholds of "really full", in percent of the model window. */
export const CONTEXT_FULL_THRESHOLDS = { warning: 50, danger: 80 } as const;

/**
 * "Autocompact soon" from 90 % of the threshold on: with the usual thresholds (≈ 167 k of a 200 k
 * window, 400 k or more of a 1 M window) 17–40 k tokens remain – one to three busy turns, early
 * enough to finish a step or compact by hand, late enough not to be on most of the time.
 */
export const AUTOCOMPACT_SOON_RATIO = 0.9;

export type ContextLevel = 'normal' | 'warning' | 'danger';

export interface ContextDisplay {
  usedTokens: number;
  /** Model window (`maxTokens`). */
  maxTokens: number;
  /** The autocompact threshold the bar is scaled to; null = scaled to `maxTokens`. */
  autoCompactAt: number | null;
  /** Fill of the bar, 0–100 (relative to the threshold or the window). */
  fill: number;
  /** Share of the model window, 0–100 (rounded down to whole percent only for the text). */
  windowPercent: number;
  /** "Really full" by `windowPercent`. */
  level: ContextLevel;
  /** At least AUTOCOMPACT_SOON_RATIO of the threshold is used. */
  compactSoon: boolean;
  /** Tokens left until the autocompact (null without a threshold). */
  tokensUntilCompact: number | null;
}

export function contextLevel(windowPercent: number): ContextLevel {
  if (windowPercent >= CONTEXT_FULL_THRESHOLDS.danger) return 'danger';
  if (windowPercent >= CONTEXT_FULL_THRESHOLDS.warning) return 'warning';
  return 'normal';
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** The autocompact threshold that applies, or null (off, unknown, or not inside the window). */
function activeThreshold(gauge: ContextGauge): number | null {
  const threshold = gauge.autoCompactThreshold;
  if (gauge.isAutoCompactEnabled !== true || threshold === null || threshold <= 0) return null;
  // A threshold beyond the window (profile override smaller than the CLI's window) cannot be reached.
  return threshold < gauge.maxTokens ? threshold : null;
}

export function contextDisplay(gauge: ContextGauge): ContextDisplay {
  const used = Math.max(0, gauge.totalTokens);
  const max = gauge.maxTokens > 0 ? gauge.maxTokens : 1;
  const threshold = activeThreshold(gauge);
  const windowPercent = (used / max) * 100;
  const scale = threshold ?? max;
  return {
    usedTokens: used,
    maxTokens: gauge.maxTokens,
    autoCompactAt: threshold,
    fill: clampPercent((used / scale) * 100),
    windowPercent,
    level: contextLevel(windowPercent),
    compactSoon: threshold !== null && used >= threshold * AUTOCOMPACT_SOON_RATIO,
    tokensUntilCompact: threshold === null ? null : Math.max(0, threshold - used),
  };
}
