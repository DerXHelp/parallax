import { memo } from 'react';
import type { DecisionCardSlotProps } from '@web/shell/slots';
import { useDecision } from '@web/state/hooks';
import { DecisionView } from './components/DecisionView';
import { TranscriptCard } from './components/TranscriptCard';

/**
 * Slot `DecisionCard` (architecture §2.3d/e, ADR-031 – variant A): renders open and expired
 * decisions and `null` once resolved (WP-15 then draws the final state from
 * `tool_call.decision.outcome`). `placement: 'bar'` is the only operable instance (the
 * DecisionBar renders it); `placement: 'transcript'` is read-only: plan text, status and "Go to
 * decision" (→ focusDecision). `useDecision` does not subscribe – the transcript/bar above holds
 * the subscription.
 */
export const DecisionCard = memo(function DecisionCard({
  sessionKey,
  decisionId,
  placement,
}: DecisionCardSlotProps) {
  const decision = useDecision(sessionKey, decisionId);
  if (decision === null) return null;
  if (placement === 'transcript') return <TranscriptCard sessionKey={sessionKey} decision={decision} />;
  return <DecisionView key={decision.id} sessionKey={sessionKey} decision={decision} />;
});
