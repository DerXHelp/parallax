import { lazy, memo, Suspense } from 'react';
import { useT } from '@web/i18n';
import { Skeleton } from '@web/ui/skeleton';

/** The panel's content is a chunk of its own: App.tsx imports this slot eagerly (WP-56). */
const PlanPanel = lazy(() => import('./components/PlanPanel'));

function PlanPanelLoading() {
  const t = useT();
  return (
    <div
      data-slot="plan-panel-loading"
      role="status"
      aria-label={t('decisions.panel.loading')}
      className="grid gap-2 px-4 py-3"
    >
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}

/**
 * Slot `PlanPanel` (Plan "Plan-Modus": the plan "vollständig im Seitenpanel", ADR-148/150): the
 * content of the side panel tab "Plan" – the plan file live while Claude writes it, every stored
 * version with its status and the diff to the version before, the plan file as a link. Opened by
 * "Open plan" (cards) or the header's "Plan" (WP-58); it stays usable after the approval and never
 * answers (answers live only in the decision bar, "Go to decision"). The frame (region, tab row,
 * close, Esc, focus return) belongs to the side panel host (shell/side-panel).
 */
export const PlanSidePanel = memo(function PlanSidePanel({ sessionKey }: { sessionKey: string }) {
  return (
    <Suspense fallback={<PlanPanelLoading />}>
      <PlanPanel sessionKey={sessionKey} />
    </Suspense>
  );
});
