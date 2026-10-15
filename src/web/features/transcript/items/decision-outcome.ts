import type { DecisionOutcome } from '@shared/model';
import type { Translate } from '../renderers/types';

export type OutcomeTone = 'success' | 'warning' | 'error' | 'muted';

/** Final state of a permission/question decision as text + tone (plan outcomes: PlanCard). */
export function decisionOutcomeText(
  outcome: DecisionOutcome,
  t: Translate,
): { text: string; tone: OutcomeTone } {
  switch (outcome.type) {
    case 'allowed': {
      const base =
        outcome.remember === null
          ? t('transcript.tool.decision.allowed')
          : t('transcript.tool.decision.allowedRemembered', {
              destination: t(`transcript.tool.decision.destinations.${outcome.remember}`),
            });
      return {
        text: outcome.acceptEdits ? `${base} · ${t('transcript.tool.decision.acceptEdits')}` : base,
        tone: 'success',
      };
    }
    case 'denied':
      return {
        text: outcome.interrupt
          ? t('transcript.tool.decision.deniedInterrupt')
          : outcome.withMessage
            ? t('transcript.tool.decision.deniedWithMessage')
            : t('transcript.tool.decision.denied'),
        tone: 'error',
      };
    case 'answered':
      return { text: t('transcript.tool.decision.answered'), tone: 'success' };
    case 'declined':
      return { text: t('transcript.tool.decision.declined'), tone: 'muted' };
    case 'cancelled':
      return { text: t('transcript.tool.decision.cancelled'), tone: 'muted' };
    case 'expired':
      return { text: t('transcript.tool.decision.expired'), tone: 'warning' };
    case 'plan_approved':
      return {
        text: t(outcome.edited ? 'transcript.plan.approvedEdited' : 'transcript.plan.approved', {
          mode: t(`shell.permissionMode.${outcome.mode}`),
        }),
        tone: 'success',
      };
    case 'plan_revised':
      return { text: t('transcript.plan.revised'), tone: 'warning' };
  }
}
