import type { ReactNode } from 'react';
import type { Decision } from '@shared/model';
import { ExpiredCard } from './ExpiredCard';
import { PermissionCard } from './PermissionCard';
import { PlanCard } from './PlanCard';
import { QuestionCard } from './QuestionCard';

/**
 * The operable card of one decision (`placement: 'bar'`). Callers key it by `decision.id`, so a
 * new decision always gets fresh buttons (and a fresh arm delay) – focus never lands on a reused
 * button of the next decision.
 */
export function DecisionView({
  sessionKey,
  decision,
  headerExtra,
}: {
  sessionKey: string;
  decision: Decision;
  headerExtra?: ReactNode;
}) {
  if (decision.state === 'expired') {
    return <ExpiredCard sessionKey={sessionKey} decision={decision} headerExtra={headerExtra} />;
  }
  switch (decision.kind) {
    case 'permission':
      return <PermissionCard sessionKey={sessionKey} decision={decision} headerExtra={headerExtra} />;
    case 'question':
      return <QuestionCard sessionKey={sessionKey} decision={decision} headerExtra={headerExtra} />;
    case 'plan':
      return <PlanCard sessionKey={sessionKey} decision={decision} headerExtra={headerExtra} />;
  }
}
