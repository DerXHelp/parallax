import { useMemo, useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { ReviewComment } from '@shared/model';
import { useI18n } from '@web/i18n';
import { useSummarySelector } from '@web/state/hooks';
import { useSessionFeature } from '@web/state/hosts';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { BranchLine, ScopeBar } from './components/ChangesHeader';
import { CommentEditor } from './components/CommentEditor';
import { CommentNote } from './components/CommentNote';
import { FileList } from './components/FileList';
import { CommitBox, GitActions } from './components/GitBar';
import { GitError } from './components/GitError';
import { SendBar } from './components/SendBar';
import { commentLocation } from './lib/feedback';
import { openReviewDraft, useReviewDraft } from './state/draft';
import { useChangesData } from './state/git';
import { useReviewComments } from './state/review';
import { clearSelection, setChangesScope, setOnlySessionFiles, useChangesView } from './state/view';

/**
 * Slot `ChangesPanel` (WP-113; WP-110 §3.4/§3.5, ADR-252…254): the side panel tab "Changes" of a
 * session – branch line, git actions (branch menu, push), compared scope and filter at the top; the
 * changed files with their diffs and review comments in the middle; "Send to Claude (n)" and the
 * commit field at the bottom. Data from the host of the session (another computer's too); only for a
 * host with `HostState.features.git` (the shell hides the tab otherwise).
 */

interface Outcome {
  kind: 'done' | 'error';
  message: string;
  error?: ErrorPayload;
}

/** Comments on files the list does not show (another scope, the filter, or a file without changes now). */
function OtherComments({ sessionKey, comments }: { sessionKey: string; comments: readonly ReviewComment[] }) {
  const { t } = useI18n();
  const draft = useReviewDraft(sessionKey);
  if (comments.length === 0) return null;
  return (
    <section data-slot="changes-other-comments" aria-label={t('changes.comments.others')} className="py-2">
      <h3 className="text-muted-foreground px-3 text-2xs font-medium">{t('changes.comments.others')}</h3>
      {comments.map((comment) =>
        draft?.target.kind === 'edit' && draft.target.commentId === comment.id ? (
          <CommentEditor
            key={comment.id}
            sessionKey={sessionKey}
            draft={draft}
            comment={comment}
            location={commentLocation(comment)}
            onClosed={() => undefined}
          />
        ) : (
          <CommentNote
            key={comment.id}
            sessionKey={sessionKey}
            comment={comment}
            state={comment.state}
            location={commentLocation(comment)}
            showQuote
            onEdit={() => {
              openReviewDraft(
                sessionKey,
                { kind: 'edit', path: comment.path, commentId: comment.id },
                comment.text,
              );
            }}
          />
        ),
      )}
    </section>
  );
}

function ChangesContent({ sessionKey }: { sessionKey: string }) {
  const { t, tError } = useI18n();
  const view = useChangesView(sessionKey);
  const worktree = useSummarySelector(sessionKey, (summary) => summary.worktree !== null, false);
  const onlySessionFiles = !worktree && view.onlySessionFiles;
  const data = useChangesData(sessionKey, view.scope, onlySessionFiles);
  const comments = useReviewComments(sessionKey);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const { status, diff, refresh } = data;

  const committable = useMemo(
    () => new Set(status?.isRepo === true ? status.files.map((file) => file.path) : []),
    [status],
  );
  // Only files that can still be committed stay picked (after a commit or a refresh).
  const selected = useMemo(
    () => view.selected.filter((path) => committable.has(path)),
    [view.selected, committable],
  );
  const listed = useMemo(() => new Set(diff?.files.map((file) => file.path) ?? []), [diff]);
  const others = useMemo(
    () => (diff === null ? [] : comments.filter((comment) => !listed.has(comment.path))),
    [comments, diff, listed],
  );

  const result = {
    onDone: (message: string) => {
      setOutcome({ kind: 'done', message });
      refresh();
    },
    onError: (message: string, error: ErrorPayload) => {
      setOutcome({ kind: 'error', message, error });
      refresh();
    },
  };

  const notRepo = status !== null && !status.isRepo;
  const firstLoad = data.loading && status === null && data.error === null;

  return (
    <section
      data-slot="changes-panel"
      data-changes-panel={sessionKey}
      aria-label={t('changes.panel.label')}
      // Only the first load: a refresh after every turn must not silence the panel for screen readers.
      aria-busy={firstLoad}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b">
        <BranchLine status={status} loading={data.loading} onRefresh={refresh} />
        {notRepo ? null : (
          <>
            <GitActions sessionKey={sessionKey} status={status} {...result} />
            <ScopeBar
              scope={view.scope}
              base={diff?.base ?? null}
              onScope={(scope) => {
                setChangesScope(sessionKey, scope);
              }}
              filter={
                worktree
                  ? null
                  : {
                      on: view.onlySessionFiles,
                      onChange: (on) => {
                        setOnlySessionFiles(sessionKey, on);
                      },
                    }
              }
            />
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-slot="changes-scroll">
        <div className="grid gap-2 px-3 pt-2 empty:hidden">
          {outcome?.kind === 'error' && outcome.error !== undefined ? (
            <GitError
              sessionKey={sessionKey}
              title={outcome.message}
              error={outcome.error}
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOutcome(null);
                  }}
                >
                  {t('changes.panel.dismiss')}
                </Button>
              }
            />
          ) : null}
          {outcome?.kind === 'done' ? (
            <p role="status" className="text-success text-xs" data-slot="changes-outcome">
              {outcome.message}
            </p>
          ) : null}
          {data.error === null ? null : data.error.code === 'GIT_FAILED' ||
            data.error.code === 'GIT_PUSH_FAILED' ? (
            <GitError
              sessionKey={sessionKey}
              title={t('changes.panel.loadError')}
              error={data.error}
              actions={
                <Button variant="outline" size="sm" onClick={refresh}>
                  {t('changes.panel.retry')}
                </Button>
              }
            />
          ) : (
            <Alert
              tone="error"
              title={t('changes.panel.loadError')}
              actions={
                <Button variant="outline" size="sm" onClick={refresh}>
                  {t('changes.panel.retry')}
                </Button>
              }
            >
              {tError(data.error)}
            </Alert>
          )}
        </div>
        {firstLoad ? (
          <p
            role="status"
            className="text-muted-foreground flex items-center gap-2 p-3 text-xs"
            data-slot="changes-loading"
          >
            <Spinner aria-hidden className="size-3.5" />
            {t('changes.panel.loading')}
          </p>
        ) : null}
        {notRepo ? (
          <p className="text-muted-foreground p-3 text-sm" data-slot="changes-not-repo">
            {t('changes.panel.notRepo')}
          </p>
        ) : null}
        {diff === null || notRepo ? null : (
          <>
            {diff.files.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm" data-slot="changes-empty">
                {t(`changes.files.empty.${view.scope}`)}
              </p>
            ) : (
              <>
                <p className="text-muted-foreground px-3 pt-2 pb-1 text-2xs" data-slot="changes-count">
                  {t('changes.files.count', { count: diff.files.length })}
                </p>
                <FileList
                  sessionKey={sessionKey}
                  root={diff.root}
                  files={diff.files}
                  scope={view.scope}
                  generation={data.generation}
                  comments={comments}
                  committable={committable}
                />
              </>
            )}
            {diff.truncated ? (
              <p className="text-muted-foreground px-3 py-1.5 text-2xs" data-slot="changes-truncated">
                {t('changes.files.truncated', { count: diff.files.length })}
              </p>
            ) : null}
            <OtherComments sessionKey={sessionKey} comments={others} />
          </>
        )}
      </div>
      {notRepo || status === null ? null : (
        <div className="shrink-0">
          <SendBar sessionKey={sessionKey} comments={comments} />
          <div className="border-t">
            <CommitBox
              sessionKey={sessionKey}
              status={status}
              selected={selected}
              onClearSelection={() => {
                clearSelection(sessionKey);
              }}
              {...result}
            />
          </div>
        </div>
      )}
    </section>
  );
}

export function ChangesPanel({ sessionKey }: { sessionKey: string }) {
  const { t } = useI18n();
  const available = useSessionFeature(sessionKey, 'git');
  if (!available) {
    return (
      <p className="text-muted-foreground p-4 text-sm" data-slot="changes-unavailable">
        {t('changes.panel.unavailable')}
      </p>
    );
  }
  return <ChangesContent key={sessionKey} sessionKey={sessionKey} />;
}

export default ChangesPanel;
