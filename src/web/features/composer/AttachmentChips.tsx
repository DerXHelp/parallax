import { CircleAlertIcon, ImageIcon, XIcon } from 'lucide-react';
import { memo, useRef, type KeyboardEvent } from 'react';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { IconButton } from '@web/ui/icon-button';
import { Spinner } from '@web/ui/spinner';
import { removeAttachment, useAttachments, type ComposerAttachment } from './state/attachments';

function useFailureText(): (attachment: ComposerAttachment) => string | null {
  const { t, tError } = useI18n();
  return (attachment) => {
    const failure = attachment.failure;
    if (failure === null) return null;
    if ('problem' in failure) return t(`composer.attachments.problem.${failure.problem}`);
    return tError(failure.error);
  };
}

/**
 * Image chips above the message field (ADR-103, WP-37 §4): preview (object URL of the picked
 * file), name, state (preparing/uploading with a spinner, error text), remove via the × button or
 * Delete/Backspace on the focused chip – the focus then moves to the next chip or the field.
 */
export const AttachmentChips = memo(function AttachmentChips({
  sessionKey,
  onFocusField,
}: {
  sessionKey: string;
  onFocusField: () => void;
}) {
  const { t } = useI18n();
  const attachments = useAttachments(sessionKey);
  const failureText = useFailureText();
  const listRef = useRef<HTMLUListElement>(null);
  if (attachments.length === 0) return null;

  const remove = (index: number, id: string) => {
    removeAttachment(sessionKey, id);
    // The focus goes to the chip that takes the place (or the one before, or the field).
    requestAnimationFrame(() => {
      const chips = listRef.current?.querySelectorAll<HTMLElement>('[data-chip-focus]') ?? [];
      const next = chips[Math.min(index, chips.length - 1)];
      if (next === undefined) onFocusField();
      else next.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number, id: string) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    remove(index, id);
  };

  return (
    <ul
      ref={listRef}
      aria-label={t('composer.attachments.list')}
      data-slot="attachment-chips"
      className="mb-1.5 flex flex-wrap gap-1.5"
    >
      {attachments.map((attachment, index) => {
        const failure = failureText(attachment);
        const status = t(`composer.attachments.status.${attachment.status}`);
        const busy = attachment.status === 'preparing' || attachment.status === 'uploading';
        return (
          <li
            key={attachment.id}
            data-slot="attachment-chip"
            data-status={attachment.status}
            className={cn(
              'bg-secondary/60 flex max-w-64 items-center gap-1.5 rounded-md border py-1 pr-0.5 pl-1',
              attachment.status === 'error' && 'border-destructive/50 bg-destructive/8',
            )}
          >
            <span
              tabIndex={0}
              data-chip-focus=""
              role="group"
              aria-label={t('composer.attachments.chip', { name: attachment.name, status })}
              title={failure ?? attachment.name}
              onKeyDown={(event) => {
                onKeyDown(event, index, attachment.id);
              }}
              className="focus-visible:ring-ring flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2"
            >
              {attachment.previewUrl === null ? (
                <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-sm">
                  <ImageIcon aria-hidden className="text-muted-foreground size-4" />
                </span>
              ) : (
                <img
                  src={attachment.previewUrl}
                  alt=""
                  className={cn('size-8 shrink-0 rounded-sm border object-cover', busy && 'opacity-60')}
                />
              )}
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-2xs font-medium">{attachment.name}</span>
                <span
                  className={cn(
                    'flex min-w-0 items-center gap-1 text-2xs',
                    attachment.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {busy ? <Spinner className="size-3" label={status} /> : null}
                  {attachment.status === 'error' ? (
                    <CircleAlertIcon aria-hidden className="size-3 shrink-0" />
                  ) : null}
                  <span className="truncate">{failure ?? status}</span>
                </span>
              </span>
            </span>
            <IconButton
              label={t('composer.attachments.remove', { name: attachment.name })}
              size="icon-xs"
              showTooltip={false}
              onClick={() => {
                remove(index, attachment.id);
              }}
            >
              <XIcon aria-hidden />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
});
