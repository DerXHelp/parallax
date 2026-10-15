/**
 * Presentation channel of a server notification in THIS window (A.9, architecture §5 "Präsenz").
 * The server picks the window and sends `delivery: 'in_app'` to a focused, visible window and
 * `'system'` to the last focused one when none is focused (src/server/sessions/notifier.ts). The
 * server's view of the presence is up to 250 ms + one round trip old, so the window follows its
 * presence at arrival: looking at the window → in-app hint (a Windows toast would only repeat it);
 * otherwise a Web Notification (Windows toast via Edge), if permitted – without permission the
 * in-app hint stays (the window title still counts the waiting sessions).
 */

/** `Notification.permission`, plus 'unsupported' where the API is missing. */
export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export type DeliveryChannel = 'in_app' | 'system';

export interface DeliveryContext {
  /** `document.hasFocus()` of this window (presence). */
  focused: boolean;
  /** `visibilityState === 'visible'` (presence). */
  visible: boolean;
  permission: NotificationPermissionState;
}

export function chooseDeliveryChannel(context: DeliveryContext): DeliveryChannel {
  if (context.focused && context.visible) return 'in_app';
  return context.permission === 'granted' ? 'system' : 'in_app';
}
