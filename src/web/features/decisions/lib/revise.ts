import { useMemo } from 'react';
import { LIMITS } from '@shared/common';
import type { PlanDecision } from '@shared/model';
import { useT } from '@web/i18n';
import { joinPlanFeedback, planFeedbackSection } from '@web/lib/plan-feedback';
import { clearDraft, getDraft, useDraft } from '../../composer/state/drafts';
import { requestComposerFocus } from '../../composer/state/focus';
import { getPlanAnnotations, usePlanAnnotations } from '../state/annotations';
import { respondToDecision } from './respond';

/**
 * "Keep planning" (WP-93, ADR-234): the feedback is built from the plan's annotations plus the
 * composer text ("General"); one entry point for the card and the plan tab. Without either the
 * focus moves into the composer (R2W-01), as before.
 */

type Translate = ReturnType<typeof useT>;

export interface PlanFeedbackState {
  /** Number of annotations of the decision (this window's view). */
  count: number;
  /** Characters of the feedback that would be sent now. */
  length: number;
  /** Something to send, within `LIMITS.planFeedbackChars`. */
  ready: boolean;
  tooLong: boolean;
}

/**
 * The annotation part of the feedback as this window shows it ('' without annotations or without
 * a plan decision); built again only when the annotations, the plan or the language change.
 */
export function usePlanFeedbackSection(decision: PlanDecision | null): string {
  const t = useT();
  const annotations = usePlanAnnotations(decision);
  const plan = decision?.plan ?? '';
  return useMemo(() => planFeedbackSection(plan, annotations, t), [plan, annotations, t]);
}

/** What "Keep planning" would send now (re-renders with the draft and the annotations). */
export function usePlanFeedback(sessionKey: string, decision: PlanDecision): PlanFeedbackState {
  const t = useT();
  const draft = useDraft(sessionKey);
  const section = usePlanFeedbackSection(decision);
  const length = joinPlanFeedback(section, draft, t).length;
  const tooLong = length > LIMITS.planFeedbackChars;
  return { count: usePlanAnnotations(decision).length, length, ready: length > 0 && !tooLong, tooLong };
}

/** Sends `revise` with the feedback; clears the composer on success. False when nothing was sent. */
export async function revisePlan(sessionKey: string, decision: PlanDecision, t: Translate): Promise<boolean> {
  const section = planFeedbackSection(decision.plan, getPlanAnnotations(decision), t);
  const feedback = joinPlanFeedback(section, getDraft(sessionKey), t);
  if (feedback === '' || feedback.length > LIMITS.planFeedbackChars) {
    requestComposerFocus(sessionKey, decision.id);
    return false;
  }
  const ok = await respondToDecision(sessionKey, decision, {
    kind: 'plan',
    response: { behavior: 'revise', feedback },
  });
  if (ok) clearDraft(sessionKey);
  return ok;
}
