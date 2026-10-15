import { useT, useI18n } from '@web/i18n';
import { parseSessionKey } from '@shared/common';
import { useHostRecord, useSelectedSession, useSessionState, useSummary } from '@web/state/hooks';
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

/**
 * One session (pane-capable: the layout may render several side by side): header, transcript
 * slot, decision bar slot, composer slot and the optional side panel slot (architecture §2.3d).
 * Subscribes the session while mounted.
 */
export function SessionPane({ sessionKey }: { sessionKey: string }) {
  const { t, tError } = useI18n();
  const summary = useSummary(sessionKey);
  const session = useSessionState(sessionKey);
  const host = useHostRecord(parseSessionKey(sessionKey)?.hostId);
  const [, select] = useSelectedSession();
  const { Transcript, DecisionBar, Composer, SidePanel } = useFeatureSlots();

  if (summary === null) {
    if (!host.summariesLoaded) return <TranscriptSkeleton />;
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
    <section
      aria-label={summary.title}
      data-session-key={sessionKey}
      className="flex h-full min-h-0 flex-col"
    >
      <SessionHeader sessionKey={sessionKey} summary={summary} />
      {session.unavailable === null ? null : (
        <div className="p-3">
          <Alert tone="error" title={t('shell.session.unavailable')}>
            {tError(session.unavailable)}
          </Alert>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          {session.view === null ? (
            session.unavailable === null ? (
              <TranscriptSkeleton />
            ) : null
          ) : (
            <Transcript sessionKey={sessionKey} />
          )}
        </div>
        <SidePanel sessionKey={sessionKey} />
      </div>
      <div data-shortcut-scope="decision-bar">
        <DecisionBar sessionKey={sessionKey} />
      </div>
      <Composer sessionKey={sessionKey} />
    </section>
  );
}
