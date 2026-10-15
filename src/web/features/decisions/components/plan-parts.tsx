import { FileTextIcon } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import type { PermissionMode } from '@shared/common';
import type { PlanDecision } from '@shared/model';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useSummarySelector } from '@web/state/hooks';
import { Button } from '@web/ui/button';
import { Gauge } from '@web/ui/gauge';
import { defaultApproveMode, orderedApproveModes } from '../lib/plan';
import { respondToDecision } from '../lib/respond';
import {
  closePlanPanel,
  isPlanPanelMounted,
  openPlanPanel,
  readApproveMode,
  usePlanPanel,
  writeApproveMode,
} from '../state/bar-store';
import { ChoiceMenu, type Choice } from './ChoiceMenu';
import { DecisionAction } from './card-shell';

/** "Implement" split button (Plan "Umsetzen ▾", C.4): the client sends only the chosen mode. */
export function useApproveMode(
  approveModes: readonly PermissionMode[],
): [PermissionMode | null, (mode: PermissionMode) => void] {
  const [mode, setMode] = useState<PermissionMode | null>(() =>
    defaultApproveMode(approveModes, readApproveMode()),
  );
  return [mode, setMode];
}

/** The approve answer for `mode`; remembers the choice (Plan: "merkt sich die letzte Wahl"). */
export function approvePlan(sessionKey: string, decision: PlanDecision, mode: PermissionMode) {
  return async () => {
    const ok = await respondToDecision(sessionKey, decision, {
      kind: 'plan',
      response: { behavior: 'approve', mode, editedPlan: null },
    });
    if (ok) writeApproveMode(mode);
    return ok;
  };
}

export function ApproveSplit({
  sessionKey,
  decision,
  mode,
  onModeChange,
  label,
}: {
  sessionKey: string;
  decision: PlanDecision;
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  /** Main button text for the mode (live: "Implement · …", expired: "Continue & implement · …"). */
  label: (modeLabel: string) => string;
}) {
  const t = useT();
  const choices: Choice<PermissionMode>[] = orderedApproveModes(decision.approveModes).map((value) => ({
    value,
    label: t(`decisions.plan.modes.${value}`),
    destructive: value === 'bypassPermissions',
  }));
  return (
    <span className="inline-flex items-center gap-px">
      <DecisionAction
        variant={mode === 'bypassPermissions' ? 'destructive' : 'default'}
        data-action="approve"
        data-mode={mode}
        onAnswer={approvePlan(sessionKey, decision, mode)}
      >
        {label(t(`decisions.plan.modesShort.${mode}`))}
      </DecisionAction>
      <ChoiceMenu
        label={t('decisions.plan.approveMenu')}
        heading={t('decisions.plan.approveMenu')}
        value={mode}
        choices={choices}
        onChange={onModeChange}
        notes={[
          {
            key: 'fresh',
            label: t('decisions.plan.freshContext'),
            hint: t('decisions.plan.freshContextHint'),
          },
        ]}
      />
    </span>
  );
}

/** Selector for the plan panel element of a session (focus after opening). */
export function findPlanPanel(sessionKey: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-plan-panel]')) {
    if (element.dataset.planPanel === sessionKey) return element;
  }
  return null;
}

/**
 * "Open plan": opens the side panel (slot `SidePanel` = PlanSidePanel) and moves the focus there
 * (user action); a second click closes it. Without a mounted panel (slot not wired) it toggles
 * the plan inside the card (`onInlineToggle`).
 */
export function OpenPlanButton({
  sessionKey,
  decision,
  inlineOpen,
  onInlineToggle,
}: {
  sessionKey: string;
  decision: PlanDecision;
  inlineOpen: boolean;
  onInlineToggle: () => void;
}) {
  const t = useT();
  const panel = usePlanPanel(sessionKey);
  const panelOpen = panel?.decisionId === decision.id;
  const open = panelOpen || inlineOpen;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (panelOpen) {
      closePlanPanel(sessionKey);
      return;
    }
    if (!isPlanPanelMounted(sessionKey)) {
      onInlineToggle();
      return;
    }
    const opener = event.currentTarget;
    flushSync(() => {
      openPlanPanel(sessionKey, decision, opener);
    });
    findPlanPanel(sessionKey)?.focus();
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
  const percent = useSummarySelector<number | null>(sessionKey, (s) => s.context?.percentage ?? null, null);
  if (percent === null) return null;
  return (
    <span className={cn('text-muted-foreground inline-flex items-center gap-1.5 text-2xs', className)}>
      <span aria-hidden>{t('decisions.plan.context')}</span>
      <Gauge value={percent} label={t('decisions.plan.context')} />
    </span>
  );
}
