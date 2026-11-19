import { MessageSquareTextIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { LIMITS } from '@shared/common';
import type { PlanDecision } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { Button } from '@web/ui/button';
import { requestComposerFocus } from '../../composer/state/focus';
import { planSummary, planTitle } from '../lib/plan';
import { revisePlan, usePlanFeedback } from '../lib/revise';
import { DecisionAction, DecisionCardShell } from './card-shell';
import { AnnotationCount, OpenPlanAnnotations } from './plan-annotations';
import {
  ApproveSplit,
  FreshContextAlert,
  OpenPlanButton,
  PlanContextGauge,
  approvePlan,
  useApproveChoice,
} from './plan-parts';

/**
 * Plan card in the bar (Plan "Plan-Modus & Plan-Freigabe"):
 * `Plan v2 bereit · [Umsetzen ▾] [Weiter planen] [Plan öffnen] · Kontext 78 %`.
 * "Implement" sends only the chosen mode (C.4); "Keep planning" sends the composer text as
 * feedback (deny + message, F.6) or – without text – moves the focus into the composer and makes
 * this plan the composer's Enter target (R2W-01). Its label never changes with the draft (R2W-16:
 * the buttons to its right do not move while the user types); "…with feedback" is the composer's.
 * WP-93: the plan's annotations go along (lib/revise.ts) and their number stands on the button.
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
  const { format } = useI18n();
  const [choice, setChoice] = useApproveChoice(decision.approveModes);
  const [inlineOpen, setInlineOpen] = useState(false);
  const title = planTitle(decision.plan);
  const titleSuffix = title === null ? null : ` · ${title}`;
  const summary = planSummary(decision.plan);
  const feedback = usePlanFeedback(sessionKey, decision);

  const revise = () => revisePlan(sessionKey, decision, t);

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
      primary={choice === null ? null : approvePlan(sessionKey, decision, choice)}
      actions={
        <>
          {choice === null ? null : (
            <ApproveSplit
              sessionKey={sessionKey}
              decision={decision}
              choice={choice}
              onChoiceChange={setChoice}
              label={(modeLabel, fresh) =>
                t(fresh ? 'decisions.plan.approveFresh' : 'decisions.plan.approve', { mode: modeLabel })
              }
            />
          )}
          {feedback.ready ? (
            <DecisionAction
              variant="outline"
              data-action="revise"
              title={
                feedback.count > 0
                  ? t('decisions.annotations.sendHint')
                  : t('decisions.plan.keepPlanningSendHint')
              }
              onAnswer={revise}
            >
              <MessageSquareTextIcon aria-hidden />
              {t('decisions.plan.keepPlanning')}
              <AnnotationCount count={feedback.count} />
            </DecisionAction>
          ) : (
            <Button
              variant="outline"
              size="sm"
              data-action="keep-planning"
              title={t('decisions.plan.keepPlanningHint')}
              onClick={() => {
                requestComposerFocus(sessionKey, decision.id);
              }}
            >
              <MessageSquareTextIcon aria-hidden />
              {t('decisions.plan.keepPlanning')}
              <AnnotationCount count={feedback.count} />
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
      {feedback.tooLong ? (
        <p role="alert" data-slot="plan-feedback-too-long" className="text-destructive text-2xs">
          {t('decisions.annotations.tooLong', {
            length: format.number(feedback.length),
            max: format.number(LIMITS.planFeedbackChars),
          })}
        </p>
      ) : null}
      <FreshContextAlert sessionKey={sessionKey} decision={decision} />
      {inlineOpen ? (
        <div
          data-slot="plan-inline"
          className="bg-background/60 mt-1 max-h-[30vh] overflow-auto rounded-md border p-2"
        >
          <OpenPlanAnnotations sessionKey={sessionKey} decision={decision} inline />
        </div>
      ) : null}
    </DecisionCardShell>
  );
}
