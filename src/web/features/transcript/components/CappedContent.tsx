import { ScissorsIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Truncation } from '@shared/model';
import { useI18n } from '@web/i18n';
import { Button } from '@web/ui/button';
import { Spinner } from '@web/ui/spinner';
import { loadFullText, useFullText } from '../state/full-text';

/**
 * Notice for a capped value (contract §5.5: `truncated = { totalChars, blobId }`) with
 * "Load full text" from the blob. Used by every renderer that shows capped text.
 */
export function TruncationNotice({
  truncated,
  shownChars = 0,
  sessionKey,
  kind = 'text',
}: {
  truncated: Truncation;
  shownChars?: number;
  sessionKey: string | null;
  /** 'input': long input strings were cut in place (the blob holds the full input JSON). */
  kind?: 'text' | 'input';
}) {
  const { t, format } = useI18n();
  const full = useFullText(truncated.blobId);
  const total = format.number(truncated.totalChars);
  const message =
    kind === 'input'
      ? t('transcript.capped.input', { total })
      : t('transcript.capped.notice', { shown: format.number(shownChars), total });
  if (full.status === 'done') {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-2xs">
        <ScissorsIcon aria-hidden className="size-3" />
        {t('transcript.capped.loaded', { total })}
      </p>
    );
  }
  return (
    <div className="border-warning/35 bg-warning/8 flex flex-wrap items-center gap-2 rounded-sm border px-2 py-1 text-2xs">
      <ScissorsIcon aria-hidden className="text-warning size-3" />
      <span className="min-w-0 flex-1">{message}</span>
      {full.status === 'loading' ? (
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <Spinner className="size-3" label={t('transcript.capped.loading')} />
          {t('transcript.capped.loading')}
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            loadFullText(truncated.blobId, sessionKey);
          }}
        >
          {full.status === 'error' ? t('transcript.capped.retry') : t('transcript.capped.loadFull')}
        </Button>
      )}
    </div>
  );
}

/**
 * Renders capped text through `children(text)`: the shortened text until the full text was
 * loaded, then the full text. The notice stays below the content.
 */
export function CappedContent({
  text,
  truncated,
  sessionKey,
  children,
}: {
  text: string;
  truncated: Truncation | null;
  sessionKey: string | null;
  children: (text: string) => ReactNode;
}) {
  const full = useFullText(truncated?.blobId ?? null);
  const shown = full.status === 'done' && full.text !== null ? full.text : text;
  return (
    <div className="grid min-w-0 gap-1">
      {children(shown)}
      {truncated === null ? null : (
        <TruncationNotice truncated={truncated} shownChars={text.length} sessionKey={sessionKey} />
      )}
    </div>
  );
}
