import { SendIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { LIMITS } from '@shared/common';
import type { ReviewComment } from '@shared/model';
import { useI18n } from '@web/i18n';
import { requestShell } from '@web/shell/requests';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { buildReviewFeedback } from '../lib/feedback';
import { markReviewSent } from '../state/git';

/**
 * "Send to Claude (n)" (WP-113, ADR-254): the open comments as one numbered list (`lib/feedback.ts`)
 * into the composer of the session as a paste chip (shell request `composerText {asPaste}`); the user
 * adds text and sends. Then `review.markSent` – the comments fold away as "sent".
 */
export function SendBar({
  sessionKey,
  comments,
}: {
  sessionKey: string;
  comments: readonly ReviewComment[];
}) {
  const { t, format } = useI18n();
  const open = useMemo(() => comments.filter((comment) => comment.state === 'open'), [comments]);
  const text = useMemo(() => buildReviewFeedback(open, t), [open, t]);
  const tooLong = text.length > LIMITS.promptChars;
  const [problem, setProblem] = useState<'noComposer' | 'markError' | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const send = () => {
    if (open.length === 0 || tooLong) return;
    setProblem(null);
    setDone(null);
    if (!requestShell({ kind: 'composerText', sessionKey, text, asPaste: true })) {
      setProblem('noComposer');
      return;
    }
    const ids = open.map((comment) => comment.id);
    markReviewSent(sessionKey, ids).then(
      () => {
        setDone(ids.length);
      },
      () => {
        setProblem('markError');
      },
    );
  };

  return (
    <div className="grid gap-1.5 border-t px-3 py-2" data-slot="changes-send">
      {tooLong ? (
        <Alert tone="error">
          {t('changes.send.tooLong', {
            length: format.number(text.length),
            max: format.number(LIMITS.promptChars),
          })}
        </Alert>
      ) : null}
      {problem === null ? null : (
        <Alert tone="error">
          {problem === 'noComposer' ? t('changes.send.noComposer') : t('changes.send.markError')}
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 text-2xs"
          role="status"
          data-slot="changes-send-status"
        >
          {done === null
            ? t('changes.send.count', { count: open.length })
            : t('changes.send.done', { count: done })}
        </span>
        <Button
          size="sm"
          variant={open.length > 0 ? 'default' : 'outline'}
          data-action="send-review"
          title={t('changes.send.hint')}
          disabled={open.length === 0 || tooLong}
          onClick={send}
        >
          <SendIcon aria-hidden />
          {t('changes.send.button')}
          <Badge variant="secondary" className="px-1 tabular-nums">
            {open.length}
          </Badge>
        </Button>
      </div>
    </div>
  );
}
