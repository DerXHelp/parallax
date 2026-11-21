import { ArrowUpIcon, GitCommitHorizontalIcon } from 'lucide-react';
import { useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { LIMITS } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { GitStatus } from '@shared/model';
import { useI18n } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Label } from '@web/ui/label';
import { Textarea } from '@web/ui/textarea';
import { commitChanges, pushBranch } from '../state/git';
import { BranchMenu } from './BranchMenu';
import { shortSha } from './ChangesHeader';

/**
 * Git bar of the tab "Changes" (WP-113, F4): branch menu and "Push" with the number of commits ahead
 * (`GitActions`), the commit field with "Commit all" or "Commit selected" (`CommitBox`). Results and
 * errors go to the panel (`onDone`/`onError`), which refreshes after every action.
 */

export interface GitActionResult {
  onDone: (message: string) => void;
  onError: (title: string, error: ErrorPayload) => void;
}

export function GitActions({
  sessionKey,
  status,
  onDone,
  onError,
}: { sessionKey: string; status: GitStatus | null } & GitActionResult) {
  const { t } = useI18n();
  const [pushing, setPushing] = useState(false);
  const repo = status?.isRepo === true;
  const onBranch = repo && status.branch !== null;
  const ahead = status?.ahead ?? 0;
  // Without an upstream, Push sets it (`-u <remote> <branch>`); with one, only when there is something.
  const canPush = onBranch && !pushing && (status.upstream === null || ahead > 0);
  const title = !onBranch
    ? t('changes.push.detached')
    : status.upstream === null
      ? t('changes.push.titleNew')
      : t('changes.push.title', { upstream: status.upstream });
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2" data-slot="changes-git-actions">
      <BranchMenu sessionKey={sessionKey} disabled={!repo} onDone={onDone} />
      <Button
        variant="outline"
        size="sm"
        data-action="git-push"
        title={title}
        disabled={!canPush}
        onClick={() => {
          setPushing(true);
          pushBranch(sessionKey).then(
            () => {
              setPushing(false);
              onDone(t('changes.push.done'));
            },
            (failure: unknown) => {
              setPushing(false);
              onError(t('changes.push.error'), errorPayloadOf(failure));
            },
          );
        }}
      >
        <ArrowUpIcon aria-hidden />
        {t('changes.push.button')}
        {ahead > 0 ? (
          <Badge variant="secondary" className="px-1 tabular-nums" data-slot="push-ahead">
            <span aria-hidden>{ahead}</span>
            <span className="sr-only">{t('changes.push.ahead', { count: ahead })}</span>
          </Badge>
        ) : null}
      </Button>
    </div>
  );
}

export function CommitBox({
  sessionKey,
  status,
  selected,
  onClearSelection,
  onDone,
  onError,
}: {
  sessionKey: string;
  status: GitStatus | null;
  /** Files picked in the list (only those with uncommitted changes); empty = all. */
  selected: readonly string[];
  onClearSelection: () => void;
} & GitActionResult) {
  const { t } = useI18n();
  const id = useId();
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const changed = status?.isRepo === true ? status.files.length : 0;
  const picked = selected.length;
  const nothing = picked === 0 && changed === 0;
  const canCommit = message.trim() !== '' && !committing && !nothing;
  const label = nothing
    ? t('changes.commit.nothing')
    : picked > 0
      ? t('changes.commit.selected', { count: picked })
      : t('changes.commit.all', { count: changed });

  const commit = () => {
    if (!canCommit) return;
    setCommitting(true);
    commitChanges(sessionKey, message.trim(), picked > 0 ? selected : undefined).then(
      (sha) => {
        setCommitting(false);
        setMessage('');
        onClearSelection();
        onDone(t('changes.commit.done', { sha: shortSha(sha) }));
      },
      (failure: unknown) => {
        setCommitting(false);
        onError(t('changes.commit.error'), errorPayloadOf(failure));
      },
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commit();
    }
  };

  return (
    <div className="grid gap-1.5 px-3 py-2" data-slot="changes-commit">
      <Label htmlFor={id} className="sr-only">
        {t('changes.commit.label')}
      </Label>
      <Textarea
        id={id}
        value={message}
        maxLength={LIMITS.gitCommitMessageChars}
        placeholder={t('changes.commit.placeholder')}
        disabled={status?.isRepo !== true}
        className="max-h-32 min-h-8 font-mono text-xs"
        onChange={(event) => {
          setMessage(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {picked > 0 ? (
          <Button variant="ghost" size="sm" onClick={onClearSelection}>
            {t('changes.commit.clearSelection')}
          </Button>
        ) : null}
        <Button size="sm" data-action="git-commit" disabled={!canCommit} onClick={commit}>
          <GitCommitHorizontalIcon aria-hidden />
          {label}
        </Button>
      </div>
    </div>
  );
}
