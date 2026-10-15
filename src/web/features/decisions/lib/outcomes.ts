import type { DecisionId } from '@shared/common';
import type { DecisionOutcome, TranscriptItem } from '@shared/model';
import type { SessionViewState } from '@shared/sync';
import type { TranslationKey } from '@web/i18n';

/**
 * Outcomes of resolved decisions as the transcript knows them (`tool_call.decision.outcome`,
 * architecture §2.3e): the `decision.resolved` op removes the decision from the view, the engine
 * writes the outcome into the gating tool call. Used for the hint when a decision disappears that
 * this window did not answer (other window, withdrawn by Claude …).
 */

const EMPTY: ReadonlyMap<DecisionId, DecisionOutcome> = new Map();
const cache = new WeakMap<readonly TranscriptItem[], ReadonlyMap<DecisionId, DecisionOutcome>>();

/** decisionId → outcome of every tool call with a resolved decision (cached per items array). */
export function selectDecisionOutcomes(view: SessionViewState): ReadonlyMap<DecisionId, DecisionOutcome> {
  const cached = cache.get(view.items);
  if (cached !== undefined) return cached;
  let result: Map<DecisionId, DecisionOutcome> | null = null;
  for (const item of view.items) {
    if (item.kind !== 'tool_call') continue;
    const ref = item.decision;
    if (ref?.outcome === undefined || ref.outcome === null) continue;
    result ??= new Map();
    result.set(ref.decisionId, ref.outcome);
  }
  const outcomes = result ?? EMPTY;
  cache.set(view.items, outcomes);
  return outcomes;
}

export const NO_OUTCOMES = EMPTY;

/** Text of the hint for a decision that was resolved without this window. */
export function resolvedElsewhereNotice(outcome: DecisionOutcome | null): TranslationKey {
  if (outcome === null) return 'decisions.notices.gone';
  if (outcome.type === 'cancelled') return `decisions.notices.withdrawn.${outcome.reason}`;
  return `decisions.notices.elsewhere.${outcome.type}`;
}
