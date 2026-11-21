import { memo, useState } from 'react';
import type { EntryId } from '@shared/common';
import type { TerminalId } from '@shared/terminal';
import type { SessionSummary } from '@shared/model';
import type { Command } from '@shared/protocol';
import { useFormat, useT } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSummarySelector } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { showSessionTerminal } from './session-actions';

interface PaneState {
  entryId: EntryId | null;
  archived: boolean;
  externalSince: string | null;
  externalRunning: boolean;
  /** 102e: claude runs in an embedded terminal of the session's computer (null = an external console). */
  externalTerminalId: TerminalId | null;
}

const NO_STATE: PaneState = {
  entryId: null,
  archived: false,
  externalSince: null,
  externalRunning: false,
  externalTerminalId: null,
};

const selectPaneState = (summary: SessionSummary): PaneState => ({
  entryId: summary.entryId,
  archived: summary.archived,
  externalSince: summary.external?.since ?? null,
  externalRunning: summary.external?.running ?? false,
  externalTerminalId: summary.external?.terminalId ?? null,
});

/**
 * Banners of a session pane (WP-35 §9): open in an external console (ADR-104: "since HH:MM", while
 * it runs the hint to quit claude there, "Take back" = `session.reclaim`; EXTERNAL_STILL_RUNNING
 * comes back as a warning notice) – for "Continue in terminal" (102e, WP-105) the same banner with
 * "Show terminal" – and archived (ADR-106: read-only until "Restore"). The composer
 * slot stays rendered (it disables itself, WP-37). Reads only these fields (no re-render on deltas).
 */
export const PaneBanners = memo(function PaneBanners({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const format = useFormat();
  const state = useSummarySelector(sessionKey, selectPaneState, NO_STATE);
  const [pending, setPending] = useState(false);
  const { entryId, externalTerminalId } = state;
  if (entryId === null) return null;
  const inTerminal = externalTerminalId !== null;

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
          data-terminal={inTerminal ? 'true' : 'false'}
          actions={
            <>
              {inTerminal && state.externalRunning ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    showSessionTerminal(sessionKey, externalTerminalId);
                  }}
                >
                  {t('navigation.pane.showTerminal')}
                </Button>
              ) : null}
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
            </>
          }
        >
          <span className="flex flex-wrap gap-x-1">
            <span className="font-medium">
              {t(inTerminal ? 'navigation.pane.terminalTitle' : 'navigation.pane.externalTitle', {
                time: format.time(state.externalSince),
              })}
            </span>
            <span className="text-muted-foreground">
              {t(
                inTerminal
                  ? state.externalRunning
                    ? 'navigation.pane.terminalRunning'
                    : 'navigation.pane.terminalEnded'
                  : state.externalRunning
                    ? 'navigation.pane.externalRunning'
                    : 'navigation.pane.externalEnded',
              )}
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
