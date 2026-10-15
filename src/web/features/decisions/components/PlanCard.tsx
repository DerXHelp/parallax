import { MessageSquareTextIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { PlanDecision } from '@shared/model';
import { useT } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { Button } from '@web/ui/button';
import { clearDraft, getDraft, useDraft } from '../../composer/state/drafts';
import { requestComposerFocus } from '../../composer/state/focus';
import { planSummary, planTitle } from '../lib/plan';
import { respondToDecision } from '../lib/respond';
import { DecisionAction, DecisionCardShell } from './card-shell';
import { ApproveSplit, OpenPlanButton, PlanContextGauge, approvePlan, useApproveMode } from './plan-parts';

/** Max length of plan feedback (contract `planResponse.revise.feedback`). */
export const PLAN_FEEDBACK_MAX = 50_000;

/**
 * Plan card in the bar (Plan "Plan-Modus & Plan-Freigabe"):
 * `Plan v2 bereit · [Umsetzen ▾] [Weiter planen] [Plan öffnen] · Kontext 78 %`.
 * "Implement" sends only the chosen mode (C.4); "Keep planning" sends the composer text as
 * feedback (deny + message, F.6) or – without text – moves the focus into the composer.
 */
export function PlanCard({
  sessionKey,
  decision,
  headerExtra,
}: {
  sessionKey: string;
  decision: PlanDecision;
  headerExtra?: ReactNode;
}) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const [mode, setMode] = useApproveMode(decision.approveModes);
  const [inlineOpen, setInlineOpen] = useState(false);
  const draft = useDraft(sessionKey).trim();
  const title = planTitle(decision.plan);
  const titleSuffix = title === null ? null : ` · ${title}`;
  const summary = planSummary(decision.plan);
  const feedbackReady = draft !== '' && draft.length <= PLAN_FEEDBACK_MAX;

  const revise = async () => {
    const feedback = getDraft(sessionKey).trim();
    if (feedback === '' || feedback.length > PLAN_FEEDBACK_MAX) {
      requestComposerFocus(sessionKey);
      return false;
    }
    const ok = await respondToDecision(sessionKey, decision, {
      kind: 'plan',
      response: { behavior: 'revise', feedback },
    });
    if (ok) clearDraft(sessionKey);
    return ok;
  };

  return (
    <DecisionCardShell
      sessionKey={sessionKey}
      decision={decision}
      title={
        <>
          {t('decisions.plan.ready', { version: decision.version })}
          {titleSuffix === null ? null : (
            <span className="text-muted-foreground font-normal">{titleSuffix}</span>
          )}
        </>
      }
      headerExtra={
        <>
          <PlanContextGauge sessionKey={sessionKey} />
          {headerExtra}
        </>
      }
      primary={mode === null ? null : approvePlan(sessionKey, decision, mode)}
      actions={
        <>
          {mode === null ? null : (
            <ApproveSplit
              sessionKey={sessionKey}
              decision={decision}
              mode={mode}
              onModeChange={setMode}
              label={(modeLabel) => t('decisions.plan.approve', { mode: modeLabel })}
            />
          )}
          {feedbackReady ? (
            <DecisionAction variant="outline" data-action="revise" onAnswer={revise}>
              <MessageSquareTextIcon aria-hidden />
              {t('decisions.plan.keepPlanningWithFeedback')}
            </DecisionAction>
          ) : (
            <Button
              variant="outline"
              size="sm"
              data-action="keep-planning"
              title={t('decisions.plan.keepPlanningHint')}
              onClick={() => {
                requestComposerFocus(sessionKey);
              }}
            >
              <MessageSquareTextIcon aria-hidden />
              {t('decisions.plan.keepPlanning')}
            </Button>
          )}
          <OpenPlanButton
            sessionKey={sessionKey}
            decision={decision}
            inlineOpen={inlineOpen}
            onInlineToggle={() => {
              setInlineOpen((open) => !open);
            }}
          />
        </>
      }
    >
      {summary === null ? null : <p className="text-muted-foreground line-clamp-2 text-xs">{summary}</p>}
      {inlineOpen ? (
        <div
          data-slot="plan-inline"
          className="bg-background/60 mt-1 max-h-[30vh] overflow-auto rounded-md border p-2"
        >
          <Markdown text={decision.plan} sessionKey={sessionKey} />
        </div>
      ) : null}
    </DecisionCardShell>
  );
}
