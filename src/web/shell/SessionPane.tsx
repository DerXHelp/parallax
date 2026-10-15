import { memo } from 'react';
import { parseSessionKey } from '@shared/common';
import { useI18n, useT } from '@web/i18n';
import { sessionTitle } from '@web/lib/session-title';
import { useSelectedSession, useSessionMeta, useSummariesLoaded, useSummarySelector } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Skeleton } from '@web/ui/skeleton';
import { SessionHeader } from './SessionHeader';
import { useFeatureSlots } from './slots';

function TranscriptSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" aria-label={t('shell.session.loading')} className="flex flex-col gap-3 p-4">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-24 w-3/4" />
    </div>
  );
}

// Slot wrappers: memo, so a re-render of the pane (title, meta) never re-renders the features.
const TranscriptSlot = memo(function TranscriptSlot({ sessionKey }: { sessionKey: string }) {
  const { Transcript } = useFeatureSlots();
  return <Transcript sessionKey={sessionKey} />;
});

const SidePanelSlot = memo(function SidePanelSlot({ sessionKey }: { sessionKey: string }) {
  const { SidePanel } = useFeatureSlots();
  return <SidePanel sessionKey={sessionKey} />;
});

/**
 * The decision bar region: `data-shortcut-scope="decision-bar"` (scoped shortcuts) and
 * `data-decision-bar` (target of `focusDecision`, decision-focus.ts; focusable by script only).
 */
const DecisionBarSlot = memo(function DecisionBarSlot({ sessionKey }: { sessionKey: string }) {
  const { DecisionBar } = useFeatureSlots();
  return (
    <div
      data-shortcut-scope="decision-bar"
      data-decision-bar={sessionKey}
      tabIndex={-1}
      className="outline-none"
    >
      <DecisionBar sessionKey={sessionKey} />
    </div>
  );
});

const ComposerSlot = memo(function ComposerSlot({ sessionKey }: { sessionKey: string }) {
  const { Composer } = useFeatureSlots();
  return <Composer sessionKey={sessionKey} />;
});

const selectTitle = (summary: { title: string; cwd: string }) => sessionTitle(summary);

/**
 * One session (pane-capable: the layout may render several side by side): header, transcript
 * slot, decision bar slot, composer slot and the optional side panel slot (architecture §2.3d).
 * Subscribes the session while mounted. Reads only narrow selectors (title, meta), so deltas and
 * summary updates of this or other sessions do not re-render the slots (R1W-04).
 */
export function SessionPane({ sessionKey }: { sessionKey: string }) {
  const { t, tError } = useI18n();
  const title = useSummarySelector<string | null>(sessionKey, selectTitle, null);
  const summariesLoaded = useSummariesLoaded(parseSessionKey(sessionKey)?.hostId);
  const meta = useSessionMeta(sessionKey);
  const [, select] = useSelectedSession();

  if (title === null) {
    if (!summariesLoaded) return <TranscriptSkeleton />;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert
          tone="warning"
          className="max-w-md"
          title={t('shell.session.notFound')}
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                select(null);
              }}
            >
              {t('shell.session.backToOverview')}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <section aria-label={title} data-session-key={sessionKey} className="flex h-full min-h-0 flex-col">
      <SessionHeader sessionKey={sessionKey} />
      {meta.unavailable === null ? null : (
        <div className="p-3">
          <Alert tone="error" title={t('shell.session.unavailable')}>
            {tError(meta.unavailable)}
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {meta.hasView ? (
            <TranscriptSlot sessionKey={sessionKey} />
          ) : meta.unavailable === null ? (
            <TranscriptSkeleton />
          ) : null}
        </div>
        <SidePanelSlot sessionKey={sessionKey} />
      </div>
      <DecisionBarSlot sessionKey={sessionKey} />
      <ComposerSlot sessionKey={sessionKey} />
    </section>
  );
}
