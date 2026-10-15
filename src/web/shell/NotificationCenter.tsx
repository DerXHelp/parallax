import { BellIcon, XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useI18n, type TranslationKey } from '@web/i18n';
import { dismissNotification, useNotifications, useSelectedSession } from '@web/state/hooks';
import type { ClientNotification } from '@web/state/store';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';

/** In-app hints stay this long unless the user acts. */
export const IN_APP_NOTIFICATION_MS = 10_000;

function textKey(notification: ClientNotification): TranslationKey {
  return `shell.notifications.kinds.${notification.kind}`;
}

function canUseSystemNotifications(): boolean {
  return typeof Notification === 'function' && Notification.permission === 'granted';
}

/**
 * Minimal notifications (Phase 1, A.9): the server picks the channel. `in_app` → a hint in this
 * window; `system` → a Web Notification (Windows toast, `tag = sessionKey`) if permission was
 * granted, otherwise also an in-app hint. Asking for permission (on click) and sounds: Phase 2.
 */
export function NotificationCenter() {
  const { t } = useI18n();
  const notifications = useNotifications();
  const [, select] = useSelectedSession();
  const handled = useRef(new Set<string>());

  useEffect(() => {
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
      setTimeout(() => {
        dismissNotification(notification.id);
      }, IN_APP_NOTIFICATION_MS);
    }
  }, [notifications, select, t]);

  const visible = notifications.filter((n) => n.delivery === 'in_app' || !canUseSystemNotifications());
  if (visible.length === 0) return null;
  return (
    <section
      aria-label={t('shell.notifications.region')}
      className="pointer-events-none fixed right-3 bottom-3 z-40 flex w-80 flex-col gap-2"
    >
      {visible.slice(-3).map((notification) => (
        <div
          key={notification.id}
          role="status"
          className="bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-2 pointer-events-auto flex items-start gap-2 rounded-md border p-2.5 text-xs shadow-lg"
        >
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
    </section>
  );
}
