import { memo } from 'react';
import { parseSessionKey } from '@shared/common';
import { useI18n, useT } from '@web/i18n';
import { sessionTitle } from '@web/lib/session-title';
import { useSelectedSession, useSessionMeta, useSummariesLoaded, useSummarySelector } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Skeleton } from '@web/ui/skeleton';
import { PaneBanners } from './navigation/PaneBanners';
import { SessionDropOverlay, useSessionDropZone } from './session-drop';
import { SessionHeader } from './SessionHeader';
import { SidePanelHost } from './side-panel/SidePanelHost';
import { useSidePanelTab } from './side-panel/state';
import { SlotBoundary } from './SlotBoundary';
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

/** Phase 3 (ADR-149): the pinned task list directly above the composer. */
const TaskStripSlot = memo(function TaskStripSlot({ sessionKey }: { sessionKey: string }) {
  const { TaskStrip } = useFeatureSlots();
  return <TaskStrip sessionKey={sessionKey} />;
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

/**
 * The side panel host inside a SlotBoundary (its frame is a lazy chunk): another tab, closing the
 * panel or another session gives a failed panel a fresh try – the header buttons still work then
 * (header-panels.tsx falls back to the panel state while no host serves the request).
 */
const SidePanelSlot = memo(function SidePanelSlot({ sessionKey }: { sessionKey: string }) {
  const tab = useSidePanelTab(sessionKey);
  return (
    <SlotBoundary resetKey={`${sessionKey}|${tab ?? ''}`} className="w-80 shrink-0 border-l">
      <SidePanelHost sessionKey={sessionKey} />
    </SlotBoundary>
  );
});

const selectTitle = (summary: { title: string; cwd: string }) => sessionTitle(summary);

/** Files may be dropped on the pane: not for an archived entry or one open in an external console. */
const selectAcceptsDrop = (summary: { archived: boolean; external: unknown }) =>
  !summary.archived && summary.external === null;

/**
 * One session (pane-capable: the layout may render several side by side): header, transcript
 * slot, the side panel host (Phase 3, ADR-150: tabs plan/file/files/tasks), decision bar slot, task
 * strip slot and composer slot (architecture §2.3d).
 * Subscribes the session while mounted. Reads only narrow selectors (title, meta), so deltas and
 * summary updates of this or other sessions do not re-render the slots (R1W-04).
 * Phase 3 (WP-58): the whole pane is a drop zone for attachments (R4W-02, session-drop.tsx); the
 * side panel (a lazy chunk) sits in a SlotBoundary, so a failed frame leaves the transcript usable.
 */
export function SessionPane({ sessionKey }: { sessionKey: string }) {
  const { t, tError } = useI18n();
  const title = useSummarySelector<string | null>(sessionKey, selectTitle, null);
  const acceptsDrop = useSummarySelector(sessionKey, selectAcceptsDrop, false);
  const summariesLoaded = useSummariesLoaded(parseSessionKey(sessionKey)?.hostId);
  const meta = useSessionMeta(sessionKey);
  const [, select] = useSelectedSession();
  const drop = useSessionDropZone(sessionKey, acceptsDrop && title !== null);

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
    <section
      aria-label={title}
      data-session-key={sessionKey}
      data-drop-zone={acceptsDrop ? 'true' : undefined}
      className="relative flex h-full min-h-0 flex-col"
      {...drop.handlers}
    >
      {drop.dragging ? <SessionDropOverlay /> : null}
      <SessionHeader sessionKey={sessionKey} />
      <PaneBanners sessionKey={sessionKey} />
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
      <TaskStripSlot sessionKey={sessionKey} />
      <ComposerSlot sessionKey={sessionKey} />
    </section>
  );
}
