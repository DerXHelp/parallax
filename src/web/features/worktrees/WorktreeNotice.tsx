import { memo, useState } from 'react';
import type { EntryId } from '@shared/common';
import type { SessionSummary, WorktreeSetup } from '@shared/model';
import type { TerminalId } from '@shared/terminal';
import { useT } from '@web/i18n';
import { openTerminalPanel, showSessionTerminal } from '@web/shell/navigation/session-actions';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useSummarySelector } from '@web/state/hooks';
import { useTerminalAvailable } from '@web/state/hosts';
import { showErrorNotice } from '@web/state/notices';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { WorktreeIdentity } from './components/WorktreeIdentity';

interface NoticeState {
  entryId: EntryId | null;
  state: WorktreeSetup['state'] | null;
  exitCode: number | null;
  terminalId: TerminalId | null;
  branch: string | null;
  portBase: number | null;
}

const NO_NOTICE: NoticeState = {
  entryId: null,
  state: null,
  exitCode: null,
  terminalId: null,
  branch: null,
  portBase: null,
};

const selectNotice = (summary: SessionSummary): NoticeState => ({
  entryId: summary.entryId,
  state: summary.worktreeSetup?.state ?? null,
  exitCode: summary.worktreeSetup?.exitCode ?? null,
  terminalId: summary.worktreeSetup?.terminalId ?? null,
  branch: summary.worktree?.branch ?? null,
  portBase: summary.worktree?.portBase ?? null,
});

/**
 * Slot `WorktreeNotice` (WP-114, ADR-250/251): one strip below the pane banners while the session's
 * worktree is being created or its setup command runs (with "Show output" = the setup's terminal tab),
 * or when that failed – exit code ≠ 0 or stopped: "Start anyway" (`session.resume`, the held first
 * message goes along) and "Show output"; `git worktree add` failed (no terminal): only the hint, the
 * transcript has the reason. Shows the worktree's branch and port block. Nothing without a setup state.
 */
export const WorktreeNotice = memo(function WorktreeNotice({ sessionKey }: { sessionKey: string }) {
  const t = useT();
  const notice = useSummarySelector(sessionKey, selectNotice, NO_NOTICE);
  const terminalAvailable = useTerminalAvailable(sessionKey);
  const [starting, setStarting] = useState(false);
  const { entryId, state, terminalId } = notice;
  if (entryId === null || state === null) return null;

  const showOutput = () => {
    if (terminalId === null) openTerminalPanel(sessionKey);
    else showSessionTerminal(sessionKey, terminalId);
  };
  const startAnyway = () => {
    setStarting(true);
    sendCommand(sessionKey, { name: 'session.resume', entryId })
      .catch((error: unknown) => {
        showErrorNotice(errorPayloadOf(error), { sessionKey });
      })
      .finally(() => {
        setStarting(false);
      });
  };
  const outputButton =
    terminalAvailable && (state === 'setup' || terminalId !== null) ? (
      <Button size="sm" variant="outline" data-action="worktree-output" onClick={showOutput}>
        {t('worktrees.notice.showOutput')}
      </Button>
    ) : null;
  const identity = <WorktreeIdentity branch={notice.branch} portBase={notice.portBase} />;

  if (state === 'creating' || state === 'setup') {
    return (
      <Banner tone="info" data-slot="worktree-notice" data-state={state} actions={outputButton ?? undefined}>
        <span className="flex flex-wrap items-center gap-x-1.5">
          <Spinner className="size-3" />
          <span className="font-medium">{t(`worktrees.notice.${state}`)}</span>
          {state === 'setup' ? (
            <span className="text-muted-foreground">{t('worktrees.notice.setupHint')}</span>
          ) : null}
          {identity}
        </span>
      </Banner>
    );
  }

  // `failed` without a terminal: `git worktree add` itself failed (the setup never ran).
  if (terminalId === null) {
    return (
      <Banner tone="error" data-slot="worktree-notice" data-state="create-failed">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span className="font-medium">{t('worktrees.notice.createFailed')}</span>
          <span className="text-muted-foreground">{t('worktrees.notice.createFailedHint')}</span>
          {identity}
        </span>
      </Banner>
    );
  }

  return (
    <Banner
      tone="warning"
      data-slot="worktree-notice"
      data-state="failed"
      actions={
        <>
          {outputButton}
          <Button
            size="sm"
            variant="outline"
            data-action="worktree-start-anyway"
            disabled={starting}
            onClick={startAnyway}
          >
            {starting ? <Spinner className="size-3" /> : null}
            {t('worktrees.notice.startAnyway')}
          </Button>
        </>
      }
    >
      <span className="flex flex-wrap items-center gap-x-1.5">
        <span className="font-medium">
          {notice.exitCode === null
            ? t('worktrees.notice.stopped')
            : t('worktrees.notice.failed', { code: String(notice.exitCode) })}
        </span>
        <span className="text-muted-foreground">{t('worktrees.notice.failedHint')}</span>
        {identity}
      </span>
    </Banner>
  );
});

export default WorktreeNotice;
