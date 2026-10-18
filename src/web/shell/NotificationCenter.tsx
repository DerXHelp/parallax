import { XIcon } from 'lucide-react';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { useSelectedSession } from '@web/state/hooks';
import { dismissNotice, useNotices, type ClientNotice } from '@web/state/notices';
import { TONE_ICON } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';

/** At most this many hints are shown at once (the newest). */
const MAX_VISIBLE = 4;

const NOTICE_ICON_TONE: Readonly<Record<ClientNotice['tone'], string>> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

const CARD =
  'bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-2 pointer-events-auto flex items-start gap-2 rounded-md border p-2.5 text-xs shadow-lg';

function NoticeCard({
  notice,
  shown,
  onShow,
}: {
  notice: ClientNotice;
  /** The notice's session is already shown in this window: no "Show session" (V2-08). */
  shown: boolean;
  onShow: (sessionKey: string) => void;
}) {
  const { t, tError } = useI18n();
  const Icon = TONE_ICON[notice.tone];
  const text =
    'error' in notice.content ? tError(notice.content.error) : t(notice.content.text, notice.content.params);
  const sessionKey = shown ? null : notice.sessionKey;
  const { action } = notice;
  return (
    <div
      data-notice={notice.id}
      data-tone={notice.tone}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={CARD}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', NOTICE_ICON_TONE[notice.tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="break-words">{text}</span>
        {sessionKey === null && action === undefined ? null : (
          <div className="flex flex-wrap gap-1.5">
            {action === undefined ? null : (
              <Button
                size="sm"
                variant="outline"
                data-notice-action
                onClick={() => {
                  action.run();
                  dismissNotice(notice.id);
                }}
              >
                {t(action.label)}
              </Button>
            )}
            {sessionKey === null ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onShow(sessionKey);
                  dismissNotice(notice.id);
                }}
              >
                {t('shell.notifications.show')}
              </Button>
            )}
          </div>
        )}
      </div>
      <IconButton
        label={t('common.dismiss')}
        size="icon-xs"
        showTooltip={false}
        onClick={() => {
          dismissNotice(notice.id);
        }}
      >
        <XIcon aria-hidden />
      </IconButton>
    </div>
  );
}

/**
 * The hint region of the window (bottom right, ADR-033): local notices of the features and the
 * shell (`showNotice`, state/notices.ts) and the in-app channel of the server notifications (A.9 –
 * src/web/notifications/delivery.ts turns each `notify` into a notice with "Show session" or into a
 * Web Notification). The region stays mounted (empty), so screen readers know it before the first
 * hint arrives.
 *
 * Above modal dialogs (ADR-126, R4W-05): `z-[60]` over their overlay (`z-50`); `aria-live` keeps
 * it out of the `aria-hidden` that a modal dialog puts on the rest of the page (Radix uses
 * `hideOthers`, which skips `[aria-live]` nodes) – "off", because the cards are the live regions
 * (`status`/`alert`). A pointerdown on a card stays here, so using a notice does not count as a
 * click outside the open dialog (which would close it).
 */
export function NotificationCenter() {
  const { t } = useI18n();
  const notices = useNotices();
  const [selected, select] = useSelectedSession();
  return (
    <section
      aria-label={t('shell.notifications.region')}
      aria-live="off"
      data-slot="notification-center"
      className="pointer-events-none fixed right-3 bottom-3 z-[60] flex w-80 flex-col gap-2"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
    >
      {notices.slice(-MAX_VISIBLE).map((notice) => (
        <NoticeCard
          key={notice.id}
          notice={notice}
          shown={notice.sessionKey !== null && notice.sessionKey === selected}
          onShow={select}
        />
      ))}
    </section>
  );
}
