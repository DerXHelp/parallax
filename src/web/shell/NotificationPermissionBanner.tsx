import { BellRingIcon } from 'lucide-react';
import { useT } from '@web/i18n';
import {
  dismissNotificationHint,
  requestNotificationPermission,
  useNotificationHintDismissed,
  useNotificationPermission,
} from '@web/notifications/permission';
import { showTextNotice } from '@web/state/notices';
import { Banner } from '@web/ui/alert';
import { Button } from '@web/ui/button';

/**
 * Asks for the Web Notification permission – only from a click (Plan B "Notification-Berechtigung
 * nur auf Klick"; Edge remembers it in the app profile). The result is confirmed with a hint.
 */
export function enableNotifications(): void {
  void requestNotificationPermission().then((result) => {
    if (result === 'granted') {
      showTextNotice('shell.notifications.permission.granted', undefined, {
        tone: 'success',
        id: 'notifications.permission',
      });
    } else if (result === 'denied') {
      showTextNotice('shell.notifications.permission.denied', undefined, {
        tone: 'warning',
        id: 'notifications.permission',
      });
    }
  });
}

/**
 * "Enable notifications" banner while the browser was never asked (permission `default`) and the
 * user did not choose "Not now" (remembered in localStorage). Without permission every server
 * notification stays an in-app hint.
 */
export function NotificationPermissionBanner() {
  const t = useT();
  const permission = useNotificationPermission();
  const dismissed = useNotificationHintDismissed();
  if (permission !== 'default' || dismissed) return null;
  return (
    <Banner
      tone="info"
      data-slot="notification-permission"
      actions={
        <>
          <Button size="sm" variant="outline" onClick={enableNotifications}>
            <BellRingIcon aria-hidden />
            {t('shell.notifications.permission.enable')}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissNotificationHint}>
            {t('shell.notifications.permission.later')}
          </Button>
        </>
      }
    >
      <span className="inline-flex flex-wrap gap-x-1.5">
        <span className="font-medium">{t('shell.notifications.permission.title')}</span>
        <span className="text-muted-foreground">{t('shell.notifications.permission.description')}</span>
      </span>
    </Banner>
  );
}
