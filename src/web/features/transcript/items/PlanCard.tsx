import { ClipboardListIcon } from 'lucide-react';
import { memo } from 'react';
import type { ToolCallItem } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { shortPath } from '@web/lib/path-display';
import { useFeatureSlots } from '@web/shell/slots';
import { useDecision } from '@web/state/hooks';
import { Disclosure } from '../components/Disclosure';
import { ModelBadge } from '../components/ModelBadge';
import { ToolFileLink } from '../components/ToolFileLink';
import { readPlanInput, readPlanResult } from '../lib/tool-input';
import { resultText, stripToolUseError } from '../lib/text';
import { Markdown } from '../markdown/Markdown';
import type { ToolBodyProps, Translate } from '../renderers/types';
import { expansionKey } from '../state/expansion';
import { useSessionCwd } from '../state/tasks';
import { decisionOutcomeText, type OutcomeTone } from './decision-outcome';

/**
 * Plan card in the transcript (ExitPlanMode, Plan "Plan-Modus & Plan-Freigabe"), rule
 * architecture §2.3e / ADR-031 (variant A):
 * - open or expired decision (`useDecision ≠ null`): the `DecisionCard` slot of WP-16 with
 *   `placement: 'transcript'` (read-only, "Go to decision") – no import from features/decisions;
 * - afterwards the final state drawn here from `tool_call.decision.outcome` and the plan from
 *   `tool_call.input.plan` (for an approval with edits the approved text of the live result).
 */

/** Never a real decision id (useDecision must be called unconditionally). */
const NO_DECISION = 'dc_none';

const TONE_CLASS: Readonly<Record<OutcomeTone, string>> = {
  success: 'border-success/40 bg-success/8 text-success',
  warning: 'border-warning/40 bg-warning/8 text-warning',
  error: 'border-destructive/40 bg-destructive/8 text-destructive',
  muted: 'border-border text-muted-foreground',
};

function planStatus(item: ToolCallItem, t: Translate): { text: string; tone: OutcomeTone } {
  const outcome = item.decision?.outcome ?? null;
  if (outcome !== null) return decisionOutcomeText(outcome, t);
  // History (no decision refs, A.3) and plans decided outside Parallax: the tool status only.
  switch (item.status) {
    case 'awaiting_decision':
    case 'pending':
    case 'streaming_input':
      return { text: t('transcript.plan.pending'), tone: 'warning' };
    case 'done':
    case 'running':
      return { text: t('transcript.plan.approvedPlain'), tone: 'success' };
    case 'denied':
    case 'error':
      return { text: t('transcript.plan.denied'), tone: 'muted' };
    case 'interrupted':
      return { text: t('transcript.plan.cancelled'), tone: 'muted' };
    case 'background':
      return { text: t('transcript.plan.unresolved'), tone: 'muted' };
  }
}

function PlanFinal({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = readPlanInput(item.input);
  const approved = readPlanResult(item.result?.structured ?? null);
  const outcome = item.decision?.outcome ?? null;
  const edited = outcome?.type === 'plan_approved' && outcome.edited;
  const fresh = outcome?.type === 'plan_approved' && outcome.freshContext;
  const plan = (edited ? approved?.plan : undefined) ?? input?.plan ?? '';
  const version = item.decision?.planVersion ?? null;
  const status = planStatus(item, t);
  const cwd = useSessionCwd(sessionKey);
  const feedback =
    outcome?.type === 'plan_revised' && item.result !== null
      ? stripToolUseError(resultText(item).text).trim()
      : '';
  return (
    <div
      data-item-kind="tool_call"
      data-tool={item.toolName}
      data-plan-state={outcome?.type ?? item.status}
      className="bg-card grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <ClipboardListIcon aria-hidden className="text-brand size-3.5 shrink-0" />
        <span className="font-medium">
          {version === null ? t('transcript.plan.title') : t('transcript.plan.version', { version })}
        </span>
        <ModelBadge model={item.model} blockIndex={item.blockIndex} />
        <span className={cn('rounded-sm border px-1.5 py-px text-2xs font-medium', TONE_CLASS[status.tone])}>
          {status.text}
        </span>
        {fresh ? (
          <span
            data-slot="plan-fresh"
            title={t('transcript.plan.freshContextHint')}
            className="border-brand/40 text-brand rounded-sm border px-1.5 py-px text-2xs font-medium"
          >
            {t('transcript.plan.freshContext')}
          </span>
        ) : null}
      </div>
      {plan === '' ? null : (
        <Disclosure
          stateKey={expansionKey(sessionKey, item.id, 'plan')}
          defaultOpen={outcome?.type !== 'plan_revised'}
          header={<span className="text-muted-foreground text-xs">{t('transcript.plan.title')}</span>}
        >
          <div className="mt-1 ml-5 min-w-0">
            <Markdown text={plan} sessionKey={sessionKey} />
          </div>
        </Disclosure>
      )}
      {feedback === '' ? null : (
        <p className="text-muted-foreground border-l-2 pl-2 text-xs break-words whitespace-pre-wrap">
          {feedback}
        </p>
      )}
      {input?.planFilePath === undefined || input.planFilePath === '' ? null : (
        <p data-slot="plan-file" className="text-muted-foreground flex min-w-0 items-center gap-1 text-2xs">
          <span className="shrink-0">{t('transcript.plan.file')}</span>
          <span className="min-w-0 truncate *:max-w-full *:truncate *:align-bottom">
            <ToolFileLink sessionKey={sessionKey} path={input.planFilePath} cwd={cwd}>
              {shortPath(input.planFilePath, 3)}
            </ToolFileLink>
          </span>
        </p>
      )}
    </div>
  );
}

export const PlanCard = memo(function PlanCard({ item, sessionKey }: ToolBodyProps) {
  const { DecisionCard } = useFeatureSlots();
  const ref = item.decision;
  const decision = useDecision(sessionKey, ref?.decisionId ?? NO_DECISION);
  if (ref !== null && ref.outcome === null && decision !== null) {
    return (
      <div
        data-item-kind="tool_call"
        data-tool={item.toolName}
        data-plan-state="decision"
        className="min-w-0"
      >
        <DecisionCard sessionKey={sessionKey} decisionId={ref.decisionId} placement="transcript" />
      </div>
    );
  }
  return <PlanFinal item={item} sessionKey={sessionKey} />;
});
