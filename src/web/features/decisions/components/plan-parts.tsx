import { FileTextIcon } from 'lucide-react';
import { useState } from 'react';
import type { PermissionMode } from '@shared/common';
import type { PlanDecision } from '@shared/model';
import { useI18n, useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { requestShell } from '@web/shell/requests';
import {
  isSidePanelHostMounted,
  useSidePanelHostMounted,
  useSidePanelTab,
} from '@web/shell/side-panel/state';
import { useSummarySelector } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Gauge } from '@web/ui/gauge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { defaultApproveMode, isFreshContextRecommended, orderedApproveModes } from '../lib/plan';
import { respondInCard, respondToDecision } from '../lib/respond';
import {
  clearFreshContextError,
  readApproveFresh,
  readApproveMode,
  setFreshContextError,
  setPanelPlan,
  useFreshContextError,
  usePlanPanel,
  writeApproveFresh,
  writeApproveMode,
} from '../state/bar-store';
import { ChoiceMenu, type Choice } from './ChoiceMenu';
import { DecisionAction } from './card-shell';

/** What "Implement" does (Plan "Umsetzen ▾", C.4, ADR-147): a mode, optionally in a fresh conversation. */
export interface ApproveChoice {
  mode: PermissionMode;
  /** "With fresh context": a new conversation that gets only the plan (approve_fresh_context). */
  fresh: boolean;
}

/** The split button's choice, starting from the remembered one (mode never bypass, fresh flag). */
export function useApproveChoice(
  approveModes: readonly PermissionMode[],
): [ApproveChoice | null, (next: ApproveChoice) => void] {
  const [choice, setChoice] = useState<ApproveChoice | null>(() => {
    const mode = defaultApproveMode(approveModes, readApproveMode());
    return mode === null ? null : { mode, fresh: readApproveFresh() };
  });
  return [choice, setChoice];
}

/**
 * Remembers the choice for the next plan (Plan: "merkt sich die letzte Wahl"). A bypass choice is
 * never remembered – neither its mode nor its fresh flag (the next plan starts from the last safe one).
 */
function rememberChoice(choice: ApproveChoice): void {
  if (choice.mode === 'bypassPermissions') return;
  writeApproveMode(choice.mode);
  writeApproveFresh(choice.fresh);
}

/**
 * The answer for `choice`. A fresh context sends `approve_fresh_context` (the server denies and
 * interrupts the open request, starts a new conversation in `mode` with the plan, ADR-147); its
 * failures (SESSION_BUSY, MODE_NOT_ALLOWED, start errors) land in the card (FreshContextAlert).
 */
export function approvePlan(sessionKey: string, decision: PlanDecision, choice: ApproveChoice) {
  return async () => {
    if (!choice.fresh) {
      const ok = await respondToDecision(sessionKey, decision, {
        kind: 'plan',
        response: { behavior: 'approve', mode: choice.mode, editedPlan: null },
      });
      if (ok) rememberChoice(choice);
      return ok;
    }
    clearFreshContextError(sessionKey);
    const result = await respondInCard(sessionKey, decision, {
      kind: 'plan',
      response: { behavior: 'approve_fresh_context', mode: choice.mode, editedPlan: null },
    });
    if (result.ok) {
      rememberChoice(choice);
      return true;
    }
    if (result.error.code !== 'DECISION_ALREADY_RESOLVED') {
      setFreshContextError(sessionKey, decision.id, result.error);
    }
    return false;
  };
}

/** Context fill of the session in % (the plan bar's gauge), null without a value. */
export function useContextPercent(sessionKey: string): number | null {
  return useSummarySelector<number | null>(sessionKey, (s) => s.context?.percentage ?? null, null);
}

/** "Recommended" next to "With fresh context" (≥ 60 % context, ADR-147); the tooltip names the fill. */
function FreshRecommendedBadge({ percent }: { percent: number }) {
  const { t, format } = useI18n();
  const hint = t('decisions.plan.freshRecommendedHint', { percent: format.percent(percent) });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="info" data-slot="fresh-recommended">
          {t('decisions.plan.freshRecommended')}
          <span className="sr-only">{hint}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export function ApproveSplit({
  sessionKey,
  decision,
  choice,
  onChoiceChange,
  label,
}: {
  sessionKey: string;
  decision: PlanDecision;
  choice: ApproveChoice;
  onChoiceChange: (choice: ApproveChoice) => void;
  /** Main button text (live: "Implement · …", expired: "Continue & implement · …"). */
  label: (modeLabel: string, fresh: boolean) => string;
}) {
  const t = useT();
  const percent = useContextPercent(sessionKey);
  const recommended = isFreshContextRecommended(percent);
  const choices: Choice<PermissionMode>[] = orderedApproveModes(decision.approveModes).map((value) => ({
    value,
    label: t(`decisions.plan.modes.${value}`),
    destructive: value === 'bypassPermissions',
  }));
  const change = (next: ApproveChoice) => {
    clearFreshContextError(sessionKey);
    onChoiceChange(next);
  };
  return (
    <span className="inline-flex items-center gap-px">
      <DecisionAction
        variant={choice.mode === 'bypassPermissions' ? 'destructive' : 'default'}
        data-action="approve"
        data-mode={choice.mode}
        data-fresh={choice.fresh ? 'true' : 'false'}
        onAnswer={approvePlan(sessionKey, decision, choice)}
      >
        {/* One label per mode everywhere ("Manual" for default, R2W-03). */}
        {label(t(`shell.permissionMode.${choice.mode}`), choice.fresh)}
      </DecisionAction>
      <ChoiceMenu
        label={t('decisions.plan.approveMenu')}
        heading={t('decisions.plan.approveMenu')}
        value={choice.mode}
        choices={choices}
        onChange={(mode) => {
          change({ ...choice, mode });
        }}
        indicator={recommended && !choice.fresh}
        toggles={[
          {
            key: 'fresh',
            label: t('decisions.plan.freshContext'),
            hint: t('decisions.plan.freshContextHint'),
            badge: recommended && percent !== null ? <FreshRecommendedBadge percent={percent} /> : undefined,
            checked: choice.fresh,
            onCheckedChange: (fresh) => {
              change({ ...choice, fresh });
            },
          },
        ]}
      />
    </span>
  );
}

/** A failed "fresh context" answer of this decision (`role="alert"`, ADR-126: errors stay in the card). */
export function FreshContextAlert({ sessionKey, decision }: { sessionKey: string; decision: PlanDecision }) {
  const { t, tError } = useI18n();
  const failure = useFreshContextError(sessionKey);
  if (failure?.decisionId !== decision.id) return null;
  return (
    <Alert
      tone="error"
      data-slot="fresh-context-error"
      title={t('decisions.plan.freshError')}
      className="mt-1"
    >
      {tError(failure.error)}
    </Alert>
  );
}

/**
 * "Open plan": shows the plan in the side panel tab "Plan" (slot `PlanPanel` = PlanSidePanel) via
 * the shell request `sidePanel` – the host moves the focus there (user action); a second click
 * closes it. Without a mounted side panel host it toggles the plan inside the card
 * (`onInlineToggle`) – or is not shown at all without that fallback (read-only transcript card,
 * R2W-15). Never an answer; a new plan decision never opens the panel by itself.
 */
export function OpenPlanButton({
  sessionKey,
  decision,
  inlineOpen = false,
  onInlineToggle,
}: {
  sessionKey: string;
  decision: PlanDecision;
  inlineOpen?: boolean;
  onInlineToggle?: () => void;
}) {
  const t = useT();
  const panel = usePlanPanel(sessionKey);
  const tab = useSidePanelTab(sessionKey);
  const mounted = useSidePanelHostMounted(sessionKey);
  const panelOpen = tab === 'plan' && panel?.decisionId === decision.id;
  const open = panelOpen || inlineOpen;
  if (!mounted && onInlineToggle === undefined) return null;
  const onClick = () => {
    if (panelOpen) {
      requestShell({ kind: 'sidePanel', sessionKey, tab: null });
      return;
    }
    if (!isSidePanelHostMounted(sessionKey)) {
      onInlineToggle?.();
      return;
    }
    setPanelPlan(sessionKey, decision);
    requestShell({ kind: 'sidePanel', sessionKey, tab: 'plan' });
  };
  return (
    <Button variant="ghost" size="sm" data-action="open-plan" aria-expanded={open} onClick={onClick}>
      <FileTextIcon aria-hidden />
      {open ? t('decisions.plan.close') : t('decisions.plan.open')}
    </Button>
  );
}

/** "Kontext 78 %" in the plan bar (read-only gauge; thresholds 70/85 %). */
export function PlanContextGauge({ sessionKey, className }: { sessionKey: string; className?: string }) {
  const t = useT();
  const percent = useContextPercent(sessionKey);
  if (percent === null) return null;
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-1.5 text-2xs', className)}>
      <span aria-hidden>{t('decisions.plan.context')}</span>
      <Gauge value={percent} label={t('decisions.plan.context')} />
    </span>
  );
}
