import { CirclePlayIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { PermissionMode } from '@shared/common';
import type { Decision } from '@shared/model';
import { useT } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { useDecisions } from '@web/state/hooks';
import { planTitle } from '../lib/plan';
import { resumeSession } from '../lib/respond';
import { summarizeToolInput } from '../lib/tool-input';
import { DecisionAction, DecisionCardShell } from './card-shell';
import { ApproveSplit, FreshContextAlert, OpenPlanButton, approvePlan, useApproveChoice } from './plan-parts';

const NO_MODES: readonly PermissionMode[] = [];

function ExpiredSummary({ decision }: { decision: Decision }) {
  const t = useT();
  switch (decision.kind) {
    case 'permission': {
      const line = `${decision.displayName ?? decision.toolName}: ${summarizeToolInput(decision.toolName, decision.input).text}`;
      return <p className="text-muted-foreground font-mono text-2xs break-all">{line}</p>;
    }
    case 'question':
      return (
        <ul className="text-muted-foreground list-disc pl-4 text-xs">
          {decision.questions.map((question) => (
            <li key={question.question}>{question.question}</li>
          ))}
        </ul>
      );
    case 'plan':
      return (
        <p className="text-muted-foreground text-xs">
          {planTitle(decision.plan) ?? t('decisions.plan.untitled')}
        </p>
      );
  }
}

/**
 * Expired decision (server restart, A.10, ADR-016): read-only. Actions: "Continue" (session.resume
 * – the server closes the expired cards) and for plans "Continue & implement" (approve with the
 * chosen mode – the server resumes and starts implementing, diagram g). Nothing else is answerable
 * (`DECISION_EXPIRED`).
 */
export function ExpiredCard({
  sessionKey,
  decision,
  headerExtra,
}: {
  sessionKey: string;
  decision: Decision;
  headerExtra?: ReactNode;
}) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const decisions = useDecisions(sessionKey);
  const [inlineOpen, setInlineOpen] = useState(false);
  const plan = decision.kind === 'plan' ? decision : null;
  const [choice, setChoice] = useApproveChoice(plan?.approveModes ?? NO_MODES);
  const expiredIds = decisions.filter((d) => d.state === 'expired').map((d) => d.id);
  const resume = () => resumeSession(sessionKey, expiredIds);
  // Not "Plan v1 ready" next to the "Expired" badge (V2-08): the plan is no longer up for review.
  const title =
    plan === null
      ? t(`decisions.kind.${decision.kind}`)
      : t('decisions.expired.planTitle', { version: plan.version });

  return (
    <DecisionCardShell
      sessionKey={sessionKey}
      decision={decision}
      title={title}
      headerExtra={headerExtra}
      primary={plan !== null && choice !== null ? approvePlan(sessionKey, plan, choice) : resume}
      actions={
        <>
          {plan === null || choice === null ? null : (
            <ApproveSplit
              sessionKey={sessionKey}
              decision={plan}
              choice={choice}
              onChoiceChange={setChoice}
              // A fresh context starts a new conversation – nothing is "continued" (ADR-147).
              label={(modeLabel, fresh) =>
                t(fresh ? 'decisions.plan.approveFresh' : 'decisions.expired.resumeApprove', {
                  mode: modeLabel,
                })
              }
            />
          )}
          <DecisionAction
            variant={plan === null ? 'default' : 'outline'}
            data-action="resume"
            onAnswer={resume}
          >
            <CirclePlayIcon aria-hidden />
            {t('decisions.expired.resume')}
          </DecisionAction>
          {plan === null ? null : (
            <OpenPlanButton
              sessionKey={sessionKey}
              decision={plan}
              inlineOpen={inlineOpen}
              onInlineToggle={() => {
                setInlineOpen((open) => !open);
              }}
            />
          )}
        </>
      }
    >
      <p className="text-xs">{t('decisions.expired.description')}</p>
      <ExpiredSummary decision={decision} />
      {plan === null ? null : <FreshContextAlert sessionKey={sessionKey} decision={plan} />}
      {plan !== null && inlineOpen ? (
        <div
          data-slot="plan-inline"
          className="bg-background/60 mt-1 max-h-[30vh] overflow-auto rounded-md border p-2"
        >
          <Markdown text={plan.plan} sessionKey={sessionKey} />
        </div>
      ) : null}
    </DecisionCardShell>
  );
}
