import { LayersIcon } from 'lucide-react';
import { PRODUCT_NAME } from '@shared/product';
import { useI18n } from '@web/i18n';
import { useSummaries } from '@web/state/hooks';
import { NewSessionForm } from './NewSessionForm';

/**
 * Right side without a selected session (B "Empty State mit zuletzt genutzten Projekten"):
 * welcome (no sessions yet) or "pick a session", both with the inline "New session" form.
 */
export function EmptyState() {
  const { t } = useI18n();
  const entries = useSummaries();
  const hasSessions = entries.some((entry) => !entry.summary.archived);
  return (
    <div
      data-slot="empty-state"
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-8"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <LayersIcon aria-hidden className="text-brand size-8" />
        <h1 className="text-base font-semibold">
          {hasSessions ? t('shell.empty.title') : t('shell.empty.welcomeTitle', { product: PRODUCT_NAME })}
        </h1>
        <p className="text-muted-foreground max-w-sm text-xs">
          {hasSessions ? t('shell.empty.description') : t('shell.empty.welcomeDescription')}
        </p>
      </div>
      <NewSessionForm />
    </div>
  );
}
