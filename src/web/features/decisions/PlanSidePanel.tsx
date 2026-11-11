import { ArrowDownToLineIcon, FileTextIcon } from 'lucide-react';
import { memo } from 'react';
import { useT } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { focusDecision } from '@web/shell/decision-focus';
import { useFeatureSlots } from '@web/shell/slots';
import { useDecision } from '@web/state/hooks';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { usePlanPanel } from './state/bar-store';

/**
 * Slot `PlanPanel` (Plan "Plan-Modus": the plan "vollständig im Seitenpanel"): the content of the
 * side panel tab "Plan" – the full plan as Markdown (slot `Markdown`, never raw HTML), opened by
 * "Open plan". The frame (region, tab row, close, Esc, focus return) belongs to the side panel host
 * (shell/side-panel, ADR-150). It keeps a copy of the plan, so it stays readable after the decision
 * was answered. Answers live only in the decision bar ("Go to decision").
 */
export const PlanSidePanel = memo(function PlanSidePanel({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const { Markdown } = useFeatureSlots();
  const panel = usePlanPanel(sessionKey);
  const live = useDecision(sessionKey, panel?.decisionId ?? '');

  if (panel === null) return null;
  const open = live?.kind === 'plan';
  const plan = live?.kind === 'plan' ? live.plan : panel.plan;
  const headingId = `plan-panel-${panel.decisionId}`;

  return (
    <section
      data-plan-panel={sessionKey}
      data-slot="plan-panel"
      aria-labelledby={headingId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <FileTextIcon aria-hidden className="text-muted-foreground size-3.5" />
        <h2 id={headingId} className="text-ui font-semibold">
          {t('decisions.panel.title', { version: panel.version })}
        </h2>
        {open ? null : <Badge variant="outline">{t('decisions.panel.closed')}</Badge>}
        <span className="flex-1" />
        {open ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              focusDecision(sessionKey, panel.decisionId);
            }}
          >
            <ArrowDownToLineIcon aria-hidden />
            {t('decisions.panel.goTo')}
          </Button>
        ) : null}
      </header>
      {panel.planFilePath === null ? null : (
        <div className="text-muted-foreground flex min-w-0 items-center gap-1 border-b px-3 py-1 text-2xs">
          <span className="shrink-0">{t('decisions.panel.file')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 truncate font-mono">{shortPath(panel.planFilePath, 3)}</span>
            </TooltipTrigger>
            <TooltipContent>
              <span className="font-mono break-all">{panel.planFilePath}</span>
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Markdown text={plan} sessionKey={sessionKey} />
      </div>
    </section>
  );
});
