import { BellIcon, XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useI18n, type TranslationKey } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { dismissNotification, useNotifications, useSelectedSession } from '@web/state/hooks';
import { dismissNotice, useNotices, type ClientNotice } from '@web/state/notices';
import type { ClientNotification } from '@web/state/store';
import { TONE_ICON } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';

/** In-app hints stay this long unless the user acts. */
export const IN_APP_NOTIFICATION_MS = 10_000;
/** At most this many server notifications and local notices are shown at once (each). */
const MAX_VISIBLE = 3;

const NOTICE_ICON_TONE: Readonly<Record<ClientNotice['tone'], string>> = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
};

function textKey(notification: ClientNotification): TranslationKey {
  return `shell.notifications.kinds.${notification.kind}`;
}

function canUseSystemNotifications(): boolean {
  return typeof Notification === 'function' && Notification.permission === 'granted';
}

const CARD =
  'bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-2 pointer-events-auto flex items-start gap-2 rounded-md border p-2.5 text-xs shadow-lg';

function NoticeCard({ notice, onShow }: { notice: ClientNotice; onShow: (sessionKey: string) => void }) {
  const { t, tError } = useI18n();
  const Icon = TONE_ICON[notice.tone];
  const text =
    'error' in notice.content ? tError(notice.content.error) : t(notice.content.text, notice.content.params);
  const sessionKey = notice.sessionKey;
  return (
    <div data-notice={notice.id} role={notice.tone === 'error' ? 'alert' : 'status'} className={CARD}>
      <Icon aria-hidden className={cn('mt-0.5 size-3.5 shrink-0', NOTICE_ICON_TONE[notice.tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="break-words">{text}</span>
        {sessionKey === null ? null : (
          <Button
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => {
              onShow(sessionKey);
              dismissNotice(notice.id);
            }}
          >
            {t('shell.notifications.show')}
          </Button>
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
 * Minimal notifications (Phase 1, A.9): the server picks the channel. `in_app` → a hint in this
 * window; `system` → a Web Notification (Windows toast, `tag = sessionKey`) if permission was
 * granted, otherwise also an in-app hint. Local notices of the window (state/notices.ts:
 * `showNotice`, R1W-07) share the region. Asking for permission (on click) and sounds: Phase 2.
 */
export function NotificationCenter() {
  const { t } = useI18n();
  const notifications = useNotifications();
  const notices = useNotices();
  const [, select] = useSelectedSession();
  const handled = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const current = new Set(notifications.map((n) => n.id));
    // Forget ids that are gone (the set would grow forever otherwise, R1W-19).
    for (const id of handled.current) if (!current.has(id)) handled.current.delete(id);
    for (const notification of notifications) {
      if (handled.current.has(notification.id)) continue;
      handled.current.add(notification.id);
      if (notification.delivery === 'system' && canUseSystemNotifications()) {
        const toast = new Notification(t(textKey(notification), { title: notification.title }), {
          tag: notification.sessionKey,
        });
        toast.onclick = () => {
          window.focus();
          select(notification.sessionKey);
          toast.close();
        };
        dismissNotification(notification.id);
        continue;
      }
      const timer = setTimeout(() => {
        timers.current.delete(notification.id);
        dismissNotification(notification.id);
      }, IN_APP_NOTIFICATION_MS);
      timers.current.set(notification.id, timer);
    }
  }, [notifications, select, t]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const visible = notifications
    .filter((n) => n.delivery === 'in_app' || !canUseSystemNotifications())
    .slice(-MAX_VISIBLE);
  // The region stays mounted (empty) so screen readers know it before the first hint arrives.
  return (
    <section
      aria-label={t('shell.notifications.region')}
      className="pointer-events-none fixed right-3 bottom-3 z-40 flex w-80 flex-col gap-2"
    >
      {visible.map((notification) => (
        <div key={notification.id} role="status" className={CARD}>
          <BellIcon aria-hidden className="text-brand mt-0.5 size-3.5 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="break-words">{t(textKey(notification), { title: notification.title })}</span>
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => {
                select(notification.sessionKey);
                dismissNotification(notification.id);
              }}
            >
              {t('shell.notifications.show')}
            </Button>
          </div>
          <IconButton
            label={t('common.dismiss')}
            size="icon-xs"
            showTooltip={false}
            onClick={() => {
              dismissNotification(notification.id);
            }}
          >
            <XIcon aria-hidden />
          </IconButton>
        </div>
      ))}
      {notices.slice(-MAX_VISIBLE).map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onShow={select} />
      ))}
    </section>
  );
}
