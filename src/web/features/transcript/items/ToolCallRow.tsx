import { CirclePauseIcon, HourglassIcon } from 'lucide-react';
import { memo } from 'react';
import type { DecisionId } from '@shared/common';
import type { ToolCallItem } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { focusDecision } from '@web/shell/decision-focus';
import { useDecision } from '@web/state/hooks';
import { Button } from '@web/ui/button';
import { Disclosure } from '../components/Disclosure';
import { ModelBadge } from '../components/ModelBadge';
import { ToolStatus } from '../components/ToolStatus';
import { getToolRenderer } from '../renderers';
import { GenericToolBody } from '../renderers/generic';
import { ToolResultImages, toolLabel } from '../renderers/parts';
import type { ToolRenderer } from '../renderers/types';
import { expansionKey } from '../state/expansion';
import { decisionOutcomeText, type OutcomeTone } from './decision-outcome';

const TONE_CLASS: Readonly<Record<OutcomeTone, string>> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
  muted: 'text-muted-foreground',
};

/**
 * A decision without outcome: open (tool call `awaiting_decision`) or expired after a server
 * restart (tool call `interrupted`, ADR-016, R2W-14) – hint + "Go to decision" (the decision bar of
 * WP-16 is the only operable instance). `useDecision` does not subscribe (the list does).
 */
function PendingDecisionLine({
  item,
  sessionKey,
  decisionId,
}: {
  item: ToolCallItem;
  sessionKey: string;
  decisionId: DecisionId;
}) {
  const t = useT();
  const decision = useDecision(sessionKey, decisionId);
  const expired = decision?.state === 'expired';
  if (!expired && item.status !== 'awaiting_decision') return null;
  const Icon = expired ? CirclePauseIcon : HourglassIcon;
  return (
    <div
      data-slot="decision-line"
      data-state={expired ? 'expired' : 'open'}
      className={cn(
        'ml-5 flex flex-wrap items-center gap-2 text-xs',
        expired ? 'text-warning' : 'text-status-waiting',
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      <span>{expired ? t('transcript.tool.decisionExpired') : t('transcript.tool.waitingForDecision')}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          focusDecision(sessionKey, decisionId);
        }}
      >
        {t('transcript.tool.goToDecision')}
      </Button>
    </div>
  );
}

/**
 * Decision of a gated tool call (architecture §2.3e): while open or expired a hint + "Go to
 * decision", afterwards the outcome from `tool_call.decision.outcome`.
 */
function DecisionLine({ item, sessionKey }: { item: ToolCallItem; sessionKey: string }) {
  const t = useT();
  const ref = item.decision;
  if (ref === null) return null;
  if (ref.outcome === null) {
    return <PendingDecisionLine item={item} sessionKey={sessionKey} decisionId={ref.decisionId} />;
  }
  const { text, tone } = decisionOutcomeText(ref.outcome, t);
  return <p className={cn('ml-5 text-2xs', TONE_CLASS[tone])}>{text}</p>;
}

/**
 * One tool call as one expandable line (Plan "Chat-Ansicht"); details from the renderer registry,
 * pictures of the result as thumbnails below the line – also while it is collapsed (R4W-03).
 */
function ToolCallFrame({
  item,
  sessionKey,
  renderer,
}: {
  item: ToolCallItem;
  sessionKey: string;
  renderer: ToolRenderer;
}) {
  const { t, format } = useI18n();
  const Icon = renderer.icon;
  const label = toolLabel(item.toolName, t);
  const summary = renderer.summary?.(item, t) ?? null;
  const meta = item.status === 'streaming_input' ? null : (renderer.meta?.(item, t) ?? null);
  const Body = renderer.Body ?? GenericToolBody;
  const running = item.status === 'running' || item.status === 'background';
  return (
    <div
      data-item-kind="tool_call"
      data-tool={item.toolName}
      data-status={item.status}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5"
    >
      <Disclosure
        stateKey={expansionKey(sessionKey, item.id)}
        defaultOpen={renderer.defaultOpen?.(item) ?? false}
        header={
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
            <ToolStatus status={item.status} />
            <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <span className="shrink-0 font-medium">{label}</span>
            <ModelBadge model={item.model} blockIndex={item.blockIndex} />
            {summary === null ? null : (
              <span className="text-muted-foreground min-w-0 truncate">{summary}</span>
            )}
            <span className="flex-1" />
            {meta === null ? null : (
              <span className="text-muted-foreground max-w-[40%] shrink-0 truncate font-mono text-2xs">
                {meta}
              </span>
            )}
            {running && item.elapsedSeconds !== null ? (
              <span className="text-muted-foreground shrink-0 text-2xs tabular-nums">
                {t('transcript.tool.elapsed', { seconds: format.number(item.elapsedSeconds) })}
              </span>
            ) : null}
          </span>
        }
      >
        <div className="mt-1 mb-1.5 ml-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
          {item.status === 'streaming_input' ? (
            <p className="text-muted-foreground text-xs italic">{t('transcript.tool.preparing')}</p>
          ) : (
            <Body item={item} sessionKey={sessionKey} />
          )}
        </div>
      </Disclosure>
      {/* Pictures of the result without expanding the line, exactly once (R4W-03, Plan). */}
      <ToolResultImages item={item} className="mb-1 ml-5" />
      <DecisionLine item={item} sessionKey={sessionKey} />
    </div>
  );
}

export const ToolCallRow = memo(function ToolCallRow({
  item,
  sessionKey,
}: {
  item: ToolCallItem;
  sessionKey: string;
}) {
  const renderer = getToolRenderer(item.toolName);
  const Row = renderer.Row;
  if (Row !== undefined) return <Row item={item} sessionKey={sessionKey} />;
  return <ToolCallFrame item={item} sessionKey={sessionKey} renderer={renderer} />;
});
