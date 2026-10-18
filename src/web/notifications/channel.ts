import type { NotificationSettings } from '@shared/model';

/**
 * Presentation channel of a server notification in THIS window (A.9, architecture §5 "Präsenz",
 * ADR-109). The server picks the window and the channel with the settings (src/server/sessions/
 * notifier.ts): `in_app` to a focused, visible window (or whenever "Do not disturb"/the event's
 * toast switch forbids OS notifications), `system` to the last focused window – or to a focused
 * one with `focusedElsewhere: 'system'`. The window follows the server; it only corrects a stale
 * presence (the server's view is up to 250 ms + one round trip old):
 * - `system` while the user looks at the window → in-app hint, unless the user wants Windows
 *   notifications there too (`focusedElsewhere: 'system'`);
 * - `in_app` while the window is in the background → Web Notification, if OS notifications are
 *   allowed for the event (never against "Do not disturb").
 * Without permission everything stays in-app (the window title still counts waiting sessions).
 */

/** `Notification.permission`, plus 'unsupported' where the API is missing. */
export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export type DeliveryChannel = 'in_app' | 'system';

export interface DeliveryContext {
  /** The server's choice (`notify.delivery`). */
  delivery: DeliveryChannel;
  /** `document.hasFocus()` of this window (presence). */
  focused: boolean;
  /** `visibilityState === 'visible'` (presence). */
  visible: boolean;
  permission: NotificationPermissionState;
  focusedElsewhere: NotificationSettings['focusedElsewhere'];
  /** OS notifications allowed for the event: `events[kind].toast` and not "Do not disturb". */
  osAllowed: boolean;
}

export function chooseDeliveryChannel(context: DeliveryContext): DeliveryChannel {
  if (context.permission !== 'granted') return 'in_app';
  const looking = context.focused && context.visible;
  if (context.delivery === 'system') {
    return looking && context.focusedElsewhere === 'in_app' ? 'in_app' : 'system';
  }
  return !looking && context.osAllowed ? 'system' : 'in_app';
}
