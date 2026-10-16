import { memo, useState } from 'react';
import type { EntryId } from '@shared/common';
import type { SessionSummary } from '@shared/model';
import type { Command } from '@shared/protocol';
import { useFormat, useT } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSummarySelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';

interface PaneState {
  entryId: EntryId | null;
  archived: boolean;
  externalSince: string | null;
  externalRunning: boolean;
}

const NO_STATE: PaneState = { entryId: null, archived: false, externalSince: null, externalRunning: false };

const selectPaneState = (summary: SessionSummary): PaneState => ({
  entryId: summary.entryId,
  archived: summary.archived,
  externalSince: summary.external?.since ?? null,
  externalRunning: summary.external?.running ?? false,
});

/**
 * Banners of a session pane (WP-35 §9): open in an external console (ADR-104: "since HH:MM", while
 * it runs the hint to quit claude there, "Take back" = `session.reclaim`; EXTERNAL_STILL_RUNNING
 * comes back as a warning notice) and archived (ADR-106: read-only until "Restore"). The composer
 * slot stays rendered (it disables itself, WP-37). Reads only these fields (no re-render on deltas).
 */
export const PaneBanners = memo(function PaneBanners({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const format = useFormat();
  const state = useSummarySelector(sessionKey, selectPaneState, NO_STATE);
  const [pending, setPending] = useState(false);
  const { entryId } = state;
  if (entryId === null) return null;

  const run = (cmd: Command) => {
    setPending(true);
    sendCommand(sessionKey, cmd)
      .catch((error: unknown) => {
        const payload = errorPayloadOf(error);
        showErrorNotice(payload, {
          sessionKey,
          tone: payload.code === 'EXTERNAL_STILL_RUNNING' ? 'warning' : 'error',
        });
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <>
      {state.externalSince === null ? null : (
        <Banner
          tone="info"
          data-slot="pane-external"
          data-running={state.externalRunning ? 'true' : 'false'}
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                run({ name: 'session.reclaim', entryId });
              }}
            >
              {t('navigation.pane.reclaim')}
            </Button>
          }
        >
          <span className="flex flex-wrap gap-x-1">
            <span className="font-medium">
              {t('navigation.pane.externalTitle', { time: format.time(state.externalSince) })}
            </span>
            <span className="text-muted-foreground">
              {t(state.externalRunning ? 'navigation.pane.externalRunning' : 'navigation.pane.externalEnded')}
            </span>
          </span>
        </Banner>
      )}
      {state.archived ? (
        <Banner
          tone="warning"
          data-slot="pane-archived"
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                run({ name: 'session.setArchived', entryId, archived: false });
              }}
            >
              {t('navigation.pane.restore')}
            </Button>
          }
        >
          <span className="flex flex-wrap gap-x-1">
            <span className="font-medium">{t('navigation.pane.archivedTitle')}</span>
            <span className="text-muted-foreground">{t('navigation.pane.archivedDescription')}</span>
          </span>
        </Banner>
      ) : null}
    </>
  );
});
