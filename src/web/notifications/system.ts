import type { NotificationPermissionState } from './channel';

/**
 * Web Notifications (Plan "Benachrichtigungen – Technik": Edge shows them as Windows toasts; a
 * click focuses the window and the session). Behind an interface so tests and the playground can
 * replace the browser API (`setSystemNotifier`). Permission is only ever requested from a click
 * (Plan B "Notification- und Ton-Berechtigung nur auf Klick").
 */

export interface SystemToast {
  close(): void;
}

export interface SystemToastOptions {
  title: string;
  body: string;
  /** `sessionKey`: a newer toast of the same session replaces the older one (protocol `notify`). */
  tag: string;
  /** No sound of the browser/OS (ADR-109: the window plays its own sound, or the event has none). */
  silent?: boolean;
  onClick: () => void;
}

export interface SystemNotifier {
  permission(): NotificationPermissionState;
  /** Must be called from a user gesture (click); resolves with the new permission. */
  requestPermission(): Promise<NotificationPermissionState>;
  /** Shows a toast; null when not permitted or the browser refused. */
  show(options: SystemToastOptions): SystemToast | null;
}

function browserPermission(): NotificationPermissionState {
  if (typeof Notification !== 'function') return 'unsupported';
  return Notification.permission;
}

export const browserNotifier: SystemNotifier = {
  permission: browserPermission,
  async requestPermission() {
    if (typeof Notification !== 'function') return 'unsupported';
    try {
      return await Notification.requestPermission();
    } catch {
      return browserPermission();
    }
  },
  show({ title, body, tag, silent = false, onClick }) {
    if (browserPermission() !== 'granted') return null;
    try {
      const toast = new Notification(title, { body, tag, silent });
      toast.onclick = (event) => {
        event.preventDefault();
        onClick();
      };
      return {
        close: () => {
          toast.close();
        },
      };
    } catch {
      return null;
    }
  },
};

let current: SystemNotifier = browserNotifier;

export function getSystemNotifier(): SystemNotifier {
  return current;
}

/** Replaces the notifier (tests, playground); returns the restore function. */
export function setSystemNotifier(notifier: SystemNotifier): () => void {
  const previous = current;
  current = notifier;
  return () => {
    current = previous;
  };
}
