/**
 * Presence and notification recording for E2E (WP-20c, WP-40). headless Edge reports every page as
 * focused and visible – an init script lets a test move a window "to the background"
 * (`document.hasFocus()` / `document.visibilityState`), wraps `Notification` (every Web Notification
 * is recorded, the toast objects stay reachable for a click) and wraps `AudioContext` (every started
 * oscillator of a notification sound is recorded, ADR-109). It also notes the presence the page
 * last sent over its WebSocket (`clientHello` / `presence`), so `setPresence` waits for exactly that
 * frame instead of a fixed time (R4W-10). The server's channel choice and the window's delivery run
 * for real.
 */
import { expect, type Page } from '@playwright/test';
import type { RecordedToast, RecordedTone, SentPresence } from './dom';

/** Init script (runs before the page's scripts): see the module comment. */
export function recordNotifications(): void {
  const toasts: RecordedToast[] = [];
  const toastObjects: Notification[] = [];
  const tones: RecordedTone[] = [];
  window.__e2eFocused = true;
  window.__e2eVisible = true;
  window.__e2eToasts = toasts;
  window.__e2eToastObjects = toastObjects;
  window.__e2eTones = tones;
  window.__e2ePresence = null;
  const Real = window.Notification;
  class Recording extends Real {
    constructor(title: string, options?: NotificationOptions) {
      toasts.push({ title, body: options?.body, tag: options?.tag, silent: options?.silent });
      super(title, options);
      toastObjects.push(this);
    }
  }
  Object.defineProperty(window, 'Notification', { value: Recording, configurable: true, writable: true });
  const RealAudio = window.AudioContext;
  class RecordingAudio extends RealAudio {
    override createOscillator(): OscillatorNode {
      const oscillator = super.createOscillator();
      let frequency: number | null = null;
      const setValueAtTime = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
      oscillator.frequency.setValueAtTime = (value: number, time: number) => {
        frequency = value;
        return setValueAtTime(value, time);
      };
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (when?: number) => {
        tones.push({ type: oscillator.type, frequency });
        start(when);
      };
      return oscillator;
    }
  }
  Object.defineProperty(window, 'AudioContext', {
    value: RecordingAudio,
    configurable: true,
    writable: true,
  });
  Document.prototype.hasFocus = function hasFocus() {
    return window.__e2eFocused ?? true;
  };
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => ((window.__e2eVisible ?? true) ? 'visible' : 'hidden'),
  });
  // The presence the page sent last (`clientHello` carries the first one, `presence` every change).
  const recordPresence = (data: unknown) => {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      (message.type === 'presence' || message.type === 'clientHello') &&
      'presence' in message &&
      typeof message.presence === 'object' &&
      message.presence !== null &&
      'focused' in message.presence &&
      'visible' in message.presence &&
      typeof message.presence.focused === 'boolean' &&
      typeof message.presence.visible === 'boolean'
    ) {
      window.__e2ePresence = { focused: message.presence.focused, visible: message.presence.visible };
    }
  };
  const RealSocket = window.WebSocket;
  class RecordingSocket extends RealSocket {
    override send(data: Parameters<WebSocket['send']>[0]): void {
      recordPresence(data);
      super.send(data);
    }
  }
  Object.defineProperty(window, 'WebSocket', { value: RecordingSocket, configurable: true, writable: true });
}

/**
 * Moves the window to the background (or back) and waits until the page has SENT that presence
 * (R4W-10): the client debounces it (250 ms, state/connection.ts), the server reads the frames of
 * one socket in order – every later command of this page is handled with the new presence. A
 * condition, no fixed wait.
 */
export async function setPresence(page: Page, presence: SentPresence): Promise<void> {
  await page.evaluate((next) => {
    window.__e2eFocused = next.focused;
    window.__e2eVisible = next.visible;
    window.dispatchEvent(new Event(next.focused ? 'focus' : 'blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, presence);
  await expect
    .poll(() => page.evaluate(() => window.__e2ePresence ?? null), {
      message: `presence ${JSON.stringify(presence)} sent`,
    })
    .toEqual(presence);
}

export function toasts(page: Page): Promise<RecordedToast[]> {
  return page.evaluate(() => window.__e2eToasts ?? []);
}

/** Clicks the last recorded Web Notification (like a click on the Edge popup). */
export async function clickLastToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__e2eToastObjects?.at(-1)?.dispatchEvent(new Event('click', { cancelable: true }));
  });
}

export function tones(page: Page): Promise<RecordedTone[]> {
  return page.evaluate(() => window.__e2eTones ?? []);
}
