import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { LIMITS } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import type { ReviewComment } from '@shared/model';
import { useI18n } from '@web/i18n';
import { errorPayloadOf } from '@web/state/connection';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { Textarea } from '@web/ui/textarea';
import { closeReviewDraft, setReviewDraftText, type ReviewDraft } from '../state/draft';
import { addReviewComment, updateReviewComment } from '../state/git';

/**
 * The comment editor below a diff line (WP-113): Markdown text, Enter saves, Shift+Enter adds a line,
 * Esc cancels (and stays with the editor – the side panel does not close). A new comment goes to the
 * server with `review.add`, an edited one with `review.update` (a sent one becomes open again, so it
 * can be sent once more). Errors stay in the editor.
 */
export function CommentEditor({
  sessionKey,
  draft,
  comment,
  location,
  onClosed,
}: {
  sessionKey: string;
  draft: ReviewDraft;
  /** The comment being edited (null = a new one). */
  comment: ReviewComment | null;
  /** `path:line` for the label. */
  location: string;
  /** After save or cancel (the diff takes the focus back). */
  onClosed: () => void;
}) {
  const { t, tError } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorPayload | null>(null);
  const text = draft.text;
  const canSave = text.trim() !== '' && !saving;

  const close = () => {
    closeReviewDraft(sessionKey);
    onClosed();
  };

  const save = () => {
    if (!canSave) return;
    const { target } = draft;
    setSaving(true);
    setError(null);
    const request =
      target.kind === 'new'
        ? addReviewComment(sessionKey, { path: target.path, ...target.anchor, text: text.trim() })
        : updateReviewComment(sessionKey, target.commentId, {
            text: text.trim(),
            ...(comment?.state === 'sent' ? { state: 'open' as const } : {}),
          });
    request.then(
      () => {
        setSaving(false);
        close();
      },
      (failure: unknown) => {
        setSaving(false);
        setError(errorPayloadOf(failure));
      },
    );
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    }
  };

  return (
    <div
      data-slot="review-editor"
      className="bg-muted/40 mx-2 my-1.5 grid gap-1.5 rounded-md border p-2 font-sans"
    >
      {draft.target.kind === 'new' && draft.target.anchor.quote !== '' ? (
        <p className="text-muted-foreground line-clamp-2 border-l-2 pl-2 font-mono text-2xs whitespace-pre-wrap">
          {draft.target.anchor.quote}
        </p>
      ) : null}
      <Textarea
        autoFocus
        value={text}
        maxLength={LIMITS.reviewCommentChars}
        aria-label={t('changes.comments.editorLabel', { location })}
        placeholder={t('changes.comments.placeholder')}
        className="bg-background max-h-48 min-h-10"
        onChange={(event) => {
          setReviewDraftText(sessionKey, event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {error === null ? null : (
        <Alert tone="error" title={t('changes.comments.saveError')}>
          {tError(error)}
        </Alert>
      )}
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={close}>
          {t('changes.comments.cancel')}
        </Button>
        <Button size="sm" data-action="save-review-comment" disabled={!canSave} onClick={save}>
          {t('changes.comments.save')}
        </Button>
      </div>
    </div>
  );
}
