import { CircleArrowUpIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { memo } from 'react';
import { useT } from '@web/i18n';
import { requestShell } from '@web/shell/requests';
import type { UpdateNoticeSlotProps } from '@web/shell/slots';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand, useHostState } from '@web/state/hooks';
import { showErrorNotice } from '@web/state/notices';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { updateNotice } from './lib/update-state';

function openUpdates(): void {
  requestShell({ kind: 'settings', section: 'updates' });
}

function dismiss(): void {
  sendCommand(null, { name: 'update.dismiss', what: 'available' }).catch((caught: unknown) => {
    showErrorNotice(errorPayloadOf(caught));
  });
}

/**
 * Slot `UpdateNotice` (head of the sidebar, WP-87 §2.3): a quiet button "Parallax <v> available" /
 * "Parallax <v> ready – restart" while `HostState.update` offers a version the user did not hide
 * (`dismissedVersion`). A click opens the settings section "Updates"; the cross hides the hint for
 * this version (`update.dismiss {what: 'available'}`, remembered by the server). `compact` (the
 * collapsed rail): the symbol only, the text as its name and tooltip.
 */
export const UpdateNotice = memo(function UpdateNotice({ compact }: UpdateNoticeSlotProps) {
  const t = useT();
  const update = useHostState()?.update ?? null;
  const notice = update === null ? null : updateNotice(update);
  if (notice === null) return null;
  const label =
    notice.kind === 'ready'
      ? t('updates.notice.ready', { version: notice.version })
      : t('updates.notice.available', { version: notice.version });
  const Icon = notice.kind === 'ready' ? RotateCwIcon : CircleArrowUpIcon;

  if (compact) {
    return (
      <span data-slot="update-notice" data-state={notice.kind} data-compact="true" className="relative">
        <IconButton
          label={label}
          tooltipSide="right"
          size="icon"
          data-action="open-updates"
          onClick={openUpdates}
        >
          <Icon aria-hidden className="text-brand" />
        </IconButton>
        <span
          aria-hidden
          className="bg-brand pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full"
        />
      </span>
    );
  }

  return (
    <div data-slot="update-notice" data-state={notice.kind} className="flex min-w-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        data-action="open-updates"
        className="text-muted-foreground hover:text-foreground min-w-0 flex-1 justify-start font-normal"
        onClick={openUpdates}
      >
        <Icon aria-hidden className="text-brand" />
        <span className="truncate">{label}</span>
      </Button>
      <IconButton
        label={t('updates.notice.dismiss')}
        size="icon-xs"
        data-action="dismiss-update-notice"
        className="text-muted-foreground"
        onClick={dismiss}
      >
        <XIcon aria-hidden />
      </IconButton>
    </div>
  );
});

export default UpdateNotice;
