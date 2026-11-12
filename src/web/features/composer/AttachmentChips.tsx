import { CircleAlertIcon, FileIcon, FileTextIcon, ImageIcon, XIcon } from 'lucide-react';
import { createElement, memo, useRef, type KeyboardEvent } from 'react';
import { LIMITS } from '@shared/common';
import { useI18n } from '@web/i18n';
import { formatFileSize } from '@web/lib/bytes';
import { cn } from '@web/lib/cn';
import { IconButton } from '@web/ui/icon-button';
import { Spinner } from '@web/ui/spinner';
import {
  attachmentsOverTotal,
  removeAttachment,
  useAttachments,
  type AttachmentKind,
  type ComposerAttachment,
} from './state/attachments';

const KIND_ICONS = { image: ImageIcon, pdf: FileTextIcon, file: FileIcon } satisfies Record<
  AttachmentKind,
  unknown
>;

function useFailureText(): (attachment: ComposerAttachment) => string | null {
  const { t, tError, format } = useI18n();
  return (attachment) => {
    const failure = attachment.failure;
    if (failure === null) return null;
    if ('problem' in failure) return t(`composer.attachments.problem.${failure.problem}`);
    if ('tooLarge' in failure) {
      return t('composer.attachments.fileTooLarge', { max: formatFileSize(failure.tooLarge, format) });
    }
    return tError(failure.error);
  };
}

/**
 * Attachment chips above the message field (ADR-103/146, WP-37 §4, WP-57): an image shows its
 * preview (object URL of the picked file), a PDF or other file an icon with its size; name and
 * state (preparing/uploading with a spinner, error text – also "File too large (max. …)" and the
 * total limit of images and PDFs, ADR-125). Remove via the × button or Delete/Backspace on the
 * focused chip – the focus then moves to the next chip or the field.
 */
export const AttachmentChips = memo(function AttachmentChips({
  sessionKey,
  onFocusField,
}: {
  sessionKey: string;
  onFocusField: () => void;
}) {
  const { t, format } = useI18n();
  const attachments = useAttachments(sessionKey);
  const failureText = useFailureText();
  const listRef = useRef<HTMLUListElement>(null);
  if (attachments.length === 0) return null;
  // ADR-125: chips beyond the total limit of one message carry the error.
  const overTotal = attachmentsOverTotal(attachments);
  const overTotalText =
    overTotal.size === 0
      ? null
      : t('composer.attachments.overTotal', { max: formatFileSize(LIMITS.attachmentsTotalBytes, format) });

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
        const tooMuch = overTotal.has(attachment.id);
        const failure = tooMuch ? overTotalText : failureText(attachment);
        const invalid = attachment.status === 'error' || tooMuch;
        const status = t(`composer.attachments.status.${attachment.status}`);
        const busy = attachment.status === 'preparing' || attachment.status === 'uploading';
        const isImage = attachment.kind === 'image';
        const size = formatFileSize(attachment.bytes, format);
        const shownStatus = tooMuch ? (failure ?? status) : status;
        const label = isImage
          ? t('composer.attachments.chip', { name: attachment.name, status: shownStatus })
          : t('composer.attachments.chipFile', {
              name: attachment.name,
              kind: t(`composer.attachments.kind.${attachment.kind}`),
              size,
              status: shownStatus,
            });
        return (
          <li
            key={attachment.id}
            data-slot="attachment-chip"
            data-kind={attachment.kind}
            data-status={attachment.status}
            data-over-total={tooMuch ? '' : undefined}
            className={cn(
              'bg-secondary/60 flex max-w-64 items-center gap-1.5 rounded-md border py-1 pr-0.5 pl-1',
              invalid && 'border-destructive/50 bg-destructive/8',
            )}
          >
            <span
              tabIndex={0}
              data-chip-focus=""
              role="group"
              aria-label={label}
              title={failure ?? attachment.name}
              onKeyDown={(event) => {
                onKeyDown(event, index, attachment.id);
              }}
              className="focus-visible:ring-ring flex min-w-0 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2"
            >
              {attachment.previewUrl === null ? (
                <span className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-sm">
                  {createElement(KIND_ICONS[attachment.kind], {
                    'aria-hidden': true,
                    className: 'text-muted-foreground size-4',
                  })}
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
                    invalid ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {busy ? <Spinner className="size-3" label={status} /> : null}
                  {invalid ? <CircleAlertIcon aria-hidden className="size-3 shrink-0" /> : null}
                  {isImage || invalid ? null : (
                    <span data-slot="attachment-size" className="shrink-0 tabular-nums">
                      {size}
                    </span>
                  )}
                  {isImage || invalid ? null : (
                    <span aria-hidden className="shrink-0">
                      ·
                    </span>
                  )}
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
