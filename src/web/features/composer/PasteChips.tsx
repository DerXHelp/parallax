import { ClipboardPasteIcon, TypeIcon, XIcon } from 'lucide-react';
import { memo, useState, type KeyboardEvent } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { Disclosure } from '@web/ui/disclosure';
import { IconButton } from '@web/ui/icon-button';
import { lineCount, type DraftPaste } from './lib/pastes';

/** Characters of a paste the open chip shows (the rest stays out of the DOM). */
export const PASTE_PREVIEW_CHARS = 4000;

/**
 * Chips of the large pasted texts (ADR-146, WP-57) above the message field: "Pasted text #k ·
 * n lines" – opening shows the beginning of the text; "Convert to text" puts the text into the
 * field instead of its token, × (or Delete/Backspace on the chip) removes the token and thus the
 * paste. The composer passes the pastes whose token stands in the field and does the edits.
 */
export const PasteChips = memo(function PasteChips({
  pastes,
  onRemove,
  onConvert,
}: {
  pastes: readonly DraftPaste[];
  onRemove: (paste: DraftPaste) => void;
  onConvert: (paste: DraftPaste) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  if (pastes.length === 0) return null;

  const toggle = (id: number, next: boolean) => {
    setOpen((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, paste: DraftPaste) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (!(event.target instanceof HTMLElement) || event.target.dataset.slot !== 'collapsible-trigger') return;
    event.preventDefault();
    onRemove(paste);
  };

  return (
    <ul
      aria-label={t('composer.pastes.list')}
      data-slot="paste-chips"
      className="mb-1.5 flex flex-wrap gap-1.5"
    >
      {pastes.map((paste) => {
        const lines = lineCount(paste.text);
        const isOpen = open.has(paste.id);
        const cut = paste.text.length > PASTE_PREVIEW_CHARS;
        return (
          <li
            key={paste.id}
            data-slot="paste-chip"
            data-paste-id={paste.id}
            data-open={isOpen ? '' : undefined}
            className={cn(
              'bg-secondary/60 min-w-0 rounded-md border py-0.5 pr-0.5 pl-0.5',
              isOpen ? 'basis-full' : 'max-w-80',
            )}
            onKeyDown={(event) => {
              onKeyDown(event, paste);
            }}
          >
            <Disclosure
              open={isOpen}
              onOpenChange={(next) => {
                toggle(paste.id, next);
              }}
              header={
                <>
                  <ClipboardPasteIcon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate text-2xs font-medium">
                    {t('composer.pastes.chip', { id: String(paste.id), count: lines })}
                  </span>
                </>
              }
              actions={
                <>
                  <IconButton
                    label={t('composer.pastes.convertLabel', { id: String(paste.id) })}
                    size="icon-xs"
                    data-action="convert-paste"
                    onClick={() => {
                      onConvert(paste);
                    }}
                  >
                    <TypeIcon aria-hidden />
                  </IconButton>
                  <IconButton
                    label={t('composer.pastes.remove', { id: String(paste.id) })}
                    size="icon-xs"
                    showTooltip={false}
                    data-action="remove-paste"
                    onClick={() => {
                      onRemove(paste);
                    }}
                  >
                    <XIcon aria-hidden />
                  </IconButton>
                </>
              }
            >
              <pre
                data-slot="paste-preview"
                className="bg-background mt-1 max-h-40 overflow-auto rounded-sm border px-1.5 py-1 font-mono text-2xs break-words whitespace-pre-wrap"
              >
                {cut ? paste.text.slice(0, PASTE_PREVIEW_CHARS) : paste.text}
              </pre>
              {cut ? (
                <p className="text-muted-foreground mt-0.5 px-0.5 text-2xs">
                  {t('composer.pastes.previewCut', { count: PASTE_PREVIEW_CHARS })}
                </p>
              ) : null}
            </Disclosure>
          </li>
        );
      })}
    </ul>
  );
});
