import { MessageSquareIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import type { ErrorPayload } from '@shared/errors';
import type { ReviewComment, ReviewState } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useFeatureSlots } from '@web/shell/slots';
import { errorPayloadOf } from '@web/state/connection';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Disclosure } from '@web/ui/disclosure';
import { IconButton } from '@web/ui/icon-button';
import { removeReviewComments } from '../state/git';

/**
 * One review comment below its line (WP-113): the Markdown text, edit and delete; an outdated one
 * (its lines are no longer in the diff) is marked and quotes what it was about. A sent comment is
 * folded to one line and opens on demand.
 */

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function NoteBody({
  sessionKey,
  comment,
  state,
  location,
  showQuote,
  onEdit,
}: {
  sessionKey: string;
  comment: ReviewComment;
  state: ReviewState;
  location: string;
  showQuote: boolean;
  onEdit: () => void;
}) {
  const { t, tError } = useI18n();
  const { Markdown } = useFeatureSlots();
  const [error, setError] = useState<ErrorPayload | null>(null);
  const [removing, setRemoving] = useState(false);
  return (
    <div
      data-slot="review-comment"
      data-comment-id={comment.id}
      data-state={state}
      className={cn(
        'group/note mx-2 my-1.5 grid gap-1 rounded-md border px-2 py-1.5 font-sans text-xs',
        state === 'stale' ? 'bg-muted/40 border-dashed' : 'border-warning/40 bg-warning/10',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <MessageSquareIcon aria-hidden className="text-warning size-3.5 shrink-0" />
        <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-2xs">
          {location}
          {comment.side === 'old' ? <span className="ml-1">{t('changes.comments.old')}</span> : null}
        </span>
        {state === 'stale' ? <Badge variant="outline">{t('changes.comments.stale')}</Badge> : null}
        {state === 'sent' ? <Badge variant="secondary">{t('changes.comments.sent')}</Badge> : null}
        <span className="flex shrink-0 items-center opacity-70 group-hover/note:opacity-100 focus-within:opacity-100">
          <IconButton label={t('changes.comments.edit')} size="icon-xs" onClick={onEdit}>
            <PencilIcon aria-hidden />
          </IconButton>
          <IconButton
            label={t('changes.comments.remove')}
            size="icon-xs"
            data-action="remove-review-comment"
            disabled={removing}
            onClick={() => {
              setRemoving(true);
              setError(null);
              removeReviewComments(sessionKey, [comment.id]).catch((failure: unknown) => {
                setRemoving(false);
                setError(errorPayloadOf(failure));
              });
            }}
          >
            <Trash2Icon aria-hidden />
          </IconButton>
        </span>
      </div>
      {state === 'stale' ? (
        <p className="text-muted-foreground text-2xs">{t('changes.comments.staleHint')}</p>
      ) : null}
      {showQuote && comment.quote !== '' ? (
        <p className="text-muted-foreground line-clamp-3 border-l-2 pl-2 font-mono text-2xs whitespace-pre-wrap">
          {comment.quote}
        </p>
      ) : null}
      <div className="min-w-0 break-words">
        <Markdown text={comment.text} sessionKey={sessionKey} />
      </div>
      {error === null ? null : (
        <Alert tone="error" title={t('changes.comments.removeError')}>
          {tError(error)}
        </Alert>
      )}
    </div>
  );
}

export function CommentNote({
  sessionKey,
  comment,
  state,
  location,
  showQuote = false,
  onEdit,
}: {
  sessionKey: string;
  comment: ReviewComment;
  /** What the window shows (`shownState`): may differ from the stored state until the server confirms. */
  state: ReviewState;
  location: string;
  /** Quote the commented lines (a comment that is not shown below its line). */
  showQuote?: boolean;
  onEdit: () => void;
}) {
  const t = useI18n().t;
  const body = (
    <NoteBody
      sessionKey={sessionKey}
      comment={comment}
      state={state}
      location={location}
      showQuote={showQuote}
      onEdit={onEdit}
    />
  );
  if (state !== 'sent') return body;
  return (
    <Disclosure
      className="mx-2 my-1 font-sans"
      label={t('changes.comments.showSent', { location })}
      header={
        <span data-slot="review-comment-sent" className="flex min-w-0 items-center gap-1.5 text-2xs">
          <Badge variant="secondary">{t('changes.comments.sent')}</Badge>
          <span className="text-muted-foreground min-w-0 truncate">{firstLine(comment.text)}</span>
        </span>
      }
      contentClassName="-mx-2"
    >
      {body}
    </Disclosure>
  );
}
