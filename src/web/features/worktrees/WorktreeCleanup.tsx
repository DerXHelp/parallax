import { CircleCheckIcon, CircleDotIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ProjectSettingsMap, WorktreeInspection } from '@shared/model';
import { useI18n } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { gitErrorDetail, projectSettingsFor } from '@web/shell/new-session/worktree-lib';
import { removeSession } from '@web/shell/navigation/remove-session';
import { openTerminalPanel } from '@web/shell/navigation/session-actions';
import { errorPayloadOf } from '@web/state/connection';
import { useHostPaths } from '@web/state/host-platform';
import { selectSummary, sendCommand, useHostState } from '@web/state/hooks';
import { useTerminalAvailable } from '@web/state/hosts';
import { clientStore } from '@web/state/store';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Checkbox } from '@web/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/ui/dialog';
import { Label } from '@web/ui/label';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Spinner } from '@web/ui/spinner';
import { WorktreeIdentity } from './components/WorktreeIdentity';
import {
  CLEANUP_OPTIONS,
  defaultCleanupOption,
  dirtyWork,
  isCleanupOption,
  losesWork,
  needsClose,
  teardownExit,
  workLost,
  type CleanupOption,
  type WorkLoss,
} from './lib/cleanup';

export interface WorktreeCleanupProps {
  sessionKey: string;
  /** What happens to the session afterwards (the menu item that asked). */
  then: 'archive' | 'remove';
  onClose: () => void;
}

type Inspection =
  | { status: 'loading' }
  | { status: 'ready'; value: WorktreeInspection }
  | { status: 'failed'; error: ErrorPayload };

type Step = 'close' | 'remove' | 'archive' | 'removeSession';

interface Overrides {
  /** "Delete anyway" after WORKTREE_DIRTY. */
  force?: boolean;
  /** "Delete anyway" after a failed teardown. */
  skipTeardown?: boolean;
}

const NO_PROJECTS: ProjectSettingsMap = Object.freeze({});

function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement
    : null;
}

function FactLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? CircleCheckIcon : TriangleAlertIcon;
  return (
    <li className="flex items-start gap-1.5" data-ok={ok ? 'true' : 'false'}>
      <Icon
        aria-hidden
        className={ok ? 'text-success mt-px size-3 shrink-0' : 'text-warning mt-px size-3 shrink-0'}
      />
      <span>{children}</span>
    </li>
  );
}

/**
 * Slot `WorktreeCleanup`, the dialog (WP-114, ADR-250): archiving or removing a session that runs in
 * its own worktree. `worktree.inspect` says what is open (uncommitted files, commits found nowhere
 * else, branch merged into the base); the options are "Keep the worktree" (chosen first while
 * something is open), "Delete the worktree, keep the branch" and "Delete the worktree and the
 * branch" – discarding open work needs the check box. Deleting: `session.close` when a process runs,
 * then `worktree.remove` (the project's teardown runs on the server, visible in the session's
 * terminal); WORKTREE_DIRTY and a failed teardown offer "Delete anyway" (`force` resp.
 * `skipTeardown`). Then the session is archived (`session.setArchived`) or removed
 * (`session.remove`). Errors show in the dialog; a failed session step after the worktree is gone
 * retries only that step.
 */
export function WorktreeCleanup({ sessionKey, then, onClose }: WorktreeCleanupProps) {
  const { t, tError } = useI18n();
  const optionsLabelId = useId();
  const confirmId = useId();
  const [snapshot] = useState(() => selectSummary(clientStore.getState(), sessionKey));
  const [returnFocus] = useState(focusedElement);
  const hostId = parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID;
  const rules = useHostPaths(hostId);
  const projects = useHostState(hostId)?.settings.projects ?? NO_PROJECTS;
  const terminalAvailable = useTerminalAvailable(sessionKey);
  const entryId = snapshot?.entryId ?? null;
  const worktree = snapshot?.worktree ?? null;
  const [inspection, setInspection] = useState<Inspection>({ status: 'loading' });
  const [choice, setChoice] = useState<CleanupOption | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [worktreeDone, setWorktreeDone] = useState(false);
  /** Archived or removed: the focus is not given back to the opener (its row may be gone). */
  const finished = useRef(false);

  useEffect(() => {
    if (entryId === null) return;
    let active = true;
    sendCommand(sessionKey, { name: 'worktree.inspect', entryId }).then(
      (value) => {
        if (active) setInspection({ status: 'ready', value });
      },
      (caught: unknown) => {
        if (active) setInspection({ status: 'failed', error: errorPayloadOf(caught) });
      },
    );
    return () => {
      active = false;
    };
  }, [sessionKey, entryId]);

  const known = inspection.status === 'ready' ? inspection.value : null;
  const option: CleanupOption =
    choice ?? (inspection.status === 'loading' ? 'keep' : defaultCleanupOption(known));
  const loss = workLost(option, known);
  const needsConfirm = losesWork(loss) && !worktreeDone;
  const running = step !== null;
  const deleting = option !== 'keep' && !worktreeDone;
  const teardown =
    deleting &&
    worktree !== null &&
    (projectSettingsFor(projects, worktree.repoRoot, rules)?.teardown.trim() ?? '') !== '';

  const lossList = (work: WorkLoss): string =>
    [
      work.files > 0 ? t('worktrees.cleanup.lossFiles', { count: work.files }) : null,
      work.commits > 0 ? t('worktrees.cleanup.lossCommits', { count: work.commits }) : null,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');

  const run = async (overrides: Overrides = {}) => {
    if (entryId === null || running) return;
    // A new check result (WORKTREE_DIRTY) must not switch the chosen option under "Delete anyway".
    setChoice(option);
    setError(null);
    try {
      if (deleting) {
        if (needsClose(selectSummary(clientStore.getState(), sessionKey))) {
          setStep('close');
          await sendCommand(sessionKey, { name: 'session.close', entryId });
        }
        setStep('remove');
        await sendCommand(sessionKey, {
          name: 'worktree.remove',
          entryId,
          deleteBranch: option === 'all',
          force: overrides.force ?? (needsConfirm && confirmed),
          skipTeardown: overrides.skipTeardown ?? false,
        });
        setWorktreeDone(true);
      }
      if (then === 'archive') {
        setStep('archive');
        await sendCommand(sessionKey, { name: 'session.setArchived', entryId, archived: true });
      } else {
        setStep('removeSession');
        await removeSession(sessionKey);
      }
      finished.current = true;
      setStep(null);
      onClose();
    } catch (caught) {
      const payload = errorPayloadOf(caught);
      const dirty = dirtyWork(payload);
      if (dirty !== null) {
        // The worktree changed since the check: show what is open now (the check box appears).
        setInspection({
          status: 'ready',
          value: {
            dirtyFiles: dirty.files,
            unpushedCommits: dirty.commits,
            branchMerged: known?.branchMerged ?? false,
          },
        });
        setConfirmed(false);
      }
      setError(payload);
      setStep(null);
    }
  };

  const close = () => {
    if (!running) onClose();
  };
  const title = snapshot?.title ?? '';
  const exit = error === null ? undefined : teardownExit(error);
  const dirty = error === null ? null : dirtyWork(error);
  const detail = error === null ? null : gitErrorDetail(error);
  const outputButton = terminalAvailable ? (
    <Button
      size="sm"
      variant="outline"
      data-action="cleanup-output"
      onClick={() => {
        openTerminalPanel(sessionKey);
      }}
    >
      {t('worktrees.cleanup.showOutput')}
    </Button>
  ) : null;

  let errorView: ReactNode = null;
  if (error !== null && exit !== undefined) {
    errorView = (
      <Alert
        tone="error"
        data-slot="cleanup-error"
        data-reason="teardown"
        title={
          exit === null
            ? t('worktrees.cleanup.teardownStopped')
            : t('worktrees.cleanup.teardownFailed', { code: String(exit) })
        }
        actions={
          <>
            {outputButton}
            <Button
              size="sm"
              variant="outline"
              data-action="cleanup-delete-anyway"
              disabled={running}
              onClick={() => {
                void run({ skipTeardown: true });
              }}
            >
              {t('worktrees.cleanup.deleteAnyway')}
            </Button>
          </>
        }
      />
    );
  } else if (error !== null && dirty !== null) {
    errorView = (
      <Alert
        tone="error"
        data-slot="cleanup-error"
        data-reason="dirty"
        title={t('worktrees.cleanup.dirtyError', { list: lossList(dirty) })}
        actions={
          <Button
            size="sm"
            variant="outline"
            data-action="cleanup-delete-anyway"
            disabled={running}
            onClick={() => {
              void run({ force: true });
            }}
          >
            {t('worktrees.cleanup.deleteAnyway')}
          </Button>
        }
      />
    );
  } else if (error !== null) {
    errorView = (
      <Alert tone="error" data-slot="cleanup-error">
        {tError(error)}
        {detail === null ? null : <span className="mt-0.5 block font-mono text-2xs break-all">{detail}</span>}
      </Alert>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-slot="worktree-cleanup"
        data-then={then}
        className="sm:max-w-lg"
        showCloseButton={!running}
        onEscapeKeyDown={(event) => {
          if (running) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (running) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // Archived or removed: the opener (a menu row) may be gone – leave the focus to the shell.
          if (finished.current || returnFocus?.isConnected !== true) return;
          event.preventDefault();
          returnFocus.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {then === 'archive'
              ? t('worktrees.cleanup.titleArchive', { title })
              : t('worktrees.cleanup.titleRemove', { title })}
          </DialogTitle>
          <DialogDescription>
            {then === 'archive'
              ? t('worktrees.cleanup.description')
              : t('worktrees.cleanup.descriptionRemove')}
          </DialogDescription>
        </DialogHeader>

        {worktree === null ? null : (
          <section
            aria-label={t('worktrees.cleanup.facts')}
            data-slot="cleanup-facts"
            className="bg-muted/40 grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border px-3 py-2 text-xs"
          >
            <WorktreeIdentity branch={worktree.branch} portBase={worktree.portBase} />
            <p className="text-muted-foreground truncate font-mono text-2xs" title={worktree.path}>
              {t('worktrees.cleanup.folder', { folder: shortPath(worktree.path, 4) })}
            </p>
            {inspection.status === 'loading' ? (
              <p className="text-muted-foreground flex items-center gap-1.5" data-slot="cleanup-checking">
                <Spinner className="size-3" />
                {t('worktrees.cleanup.checking')}
              </p>
            ) : null}
            {inspection.status === 'failed' ? (
              <Alert tone="error" data-slot="cleanup-check-failed" title={t('worktrees.cleanup.checkFailed')}>
                {tError(inspection.error)}
              </Alert>
            ) : null}
            {known === null ? null : (
              <ul className="grid gap-1" data-slot="cleanup-inspection">
                <FactLine ok={known.dirtyFiles === 0}>
                  {known.dirtyFiles === 0
                    ? t('worktrees.cleanup.clean')
                    : t('worktrees.cleanup.dirty', { count: known.dirtyFiles })}
                </FactLine>
                <FactLine ok={known.unpushedCommits === 0}>
                  {known.unpushedCommits === 0
                    ? t('worktrees.cleanup.pushed')
                    : t('worktrees.cleanup.unpushed', { count: known.unpushedCommits })}
                </FactLine>
                <li className="text-muted-foreground flex items-start gap-1.5">
                  <CircleDotIcon aria-hidden className="mt-px size-3 shrink-0" />
                  <span>
                    {known.branchMerged
                      ? t('worktrees.cleanup.merged', { base: worktree.baseRef })
                      : t('worktrees.cleanup.notMerged', { base: worktree.baseRef })}
                  </span>
                </li>
              </ul>
            )}
          </section>
        )}

        {worktreeDone ? (
          <Alert tone="info" data-slot="cleanup-worktree-gone">
            {t('worktrees.cleanup.worktreeGone')}
          </Alert>
        ) : (
          <div className="grid gap-1.5">
            <span id={optionsLabelId} className="text-xs font-medium">
              {t('worktrees.cleanup.optionsLabel')}
            </span>
            <RadioGroup
              aria-labelledby={optionsLabelId}
              value={option}
              disabled={running}
              onValueChange={(value) => {
                if (!isCleanupOption(value)) return;
                setChoice(value);
                setConfirmed(false);
                setError(null);
              }}
              className="grid gap-2"
              data-slot="cleanup-options"
            >
              {CLEANUP_OPTIONS.map((value) => (
                <div key={value} className="flex items-start gap-2">
                  <RadioGroupItem id={`${optionsLabelId}-${value}`} value={value} className="mt-0.5" />
                  <div className="grid gap-0.5">
                    <Label htmlFor={`${optionsLabelId}-${value}`} className="font-normal">
                      {t(`worktrees.cleanup.options.${value}`)}
                    </Label>
                    <p className="text-muted-foreground text-2xs">
                      {t(`worktrees.cleanup.optionHints.${value}`)}
                    </p>
                  </div>
                </div>
              ))}
            </RadioGroup>
          </div>
        )}

        {needsConfirm ? (
          <div className="flex items-start gap-2" data-slot="cleanup-confirm">
            <Checkbox
              id={confirmId}
              checked={confirmed}
              disabled={running}
              onCheckedChange={(checked) => {
                setConfirmed(checked === true);
              }}
              className="mt-0.5"
            />
            <Label htmlFor={confirmId} className="text-destructive leading-snug font-normal">
              {t('worktrees.cleanup.confirmLoss', { list: lossList(loss) })}
            </Label>
          </div>
        ) : null}

        {teardown ? (
          <p className="text-muted-foreground text-2xs" data-slot="cleanup-teardown">
            {t('worktrees.cleanup.teardown')}
          </p>
        ) : null}

        {errorView}

        <DialogFooter className="items-center">
          {step === null ? null : (
            <span className="text-muted-foreground mr-auto flex items-center gap-1.5 text-2xs" role="status">
              <Spinner className="size-3" />
              {t(`worktrees.cleanup.steps.${step}`)}
            </span>
          )}
          {step === 'remove' && teardown ? outputButton : null}
          <Button variant="outline" disabled={running} onClick={close}>
            {t('worktrees.cleanup.cancel')}
          </Button>
          <Button
            variant={deleting ? 'destructive' : 'default'}
            data-action="cleanup-confirm"
            disabled={running || entryId === null || (needsConfirm && !confirmed)}
            onClick={() => {
              void run();
            }}
          >
            {then === 'archive'
              ? t('worktrees.cleanup.confirmArchive')
              : t('worktrees.cleanup.confirmRemove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default WorktreeCleanup;
