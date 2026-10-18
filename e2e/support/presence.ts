/**
 * Presence and notification recording for E2E (WP-20c, WP-40). headless Edge reports every page as
 * focused and visible – an init script lets a test move a window "to the background"
 * (`document.hasFocus()` / `document.visibilityState`), wraps `Notification` (every Web Notification
 * is recorded, the toast objects stay reachable for a click) and wraps `AudioContext` (every started
 * oscillator of a notification sound is recorded, ADR-109). The server's channel choice and the
 * window's delivery run for real.
 */
import type { Page } from '@playwright/test';

export interface RecordedToast {
  title: string;
  body: string | undefined;
  tag: string | undefined;
  silent: boolean | null | undefined;
}

export interface RecordedTone {
  type: string;
  frequency: number | null;
}

interface RecordingWindow {
  __e2eFocused: boolean;
  __e2eVisible: boolean;
  __e2eToasts: RecordedToast[];
  __e2eToastObjects: Notification[];
  __e2eTones: RecordedTone[];
}

/** Init script (runs before the page's scripts): see the module comment. */
export function recordNotifications(): void {
  const w = window as unknown as RecordingWindow;
  w.__e2eFocused = true;
  w.__e2eVisible = true;
  w.__e2eToasts = [];
  w.__e2eToastObjects = [];
  w.__e2eTones = [];
  const Real = window.Notification;
  class Recording extends Real {
    constructor(title: string, options?: NotificationOptions) {
      w.__e2eToasts.push({ title, body: options?.body, tag: options?.tag, silent: options?.silent });
      super(title, options);
      w.__e2eToastObjects.push(this);
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
        w.__e2eTones.push({ type: oscillator.type, frequency });
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
    return w.__e2eFocused;
  };
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (w.__e2eVisible ? 'visible' : 'hidden'),
  });
}

/** Moves the window to the background (or back) and lets the presence reach the server. */
export async function setPresence(
  page: Page,
  presence: { focused: boolean; visible: boolean },
): Promise<void> {
  await page.evaluate((next) => {
    const w = window as unknown as RecordingWindow;
    w.__e2eFocused = next.focused;
    w.__e2eVisible = next.visible;
    window.dispatchEvent(new Event(next.focused ? 'focus' : 'blur'));
    document.dispatchEvent(new Event('visibilitychange'));
  }, presence);
  // presence is debounced 250 ms (connection.ts)
  await page.waitForTimeout(700);
}

export function toasts(page: Page): Promise<RecordedToast[]> {
  return page.evaluate(() => (window as unknown as RecordingWindow).__e2eToasts);
}

/** Clicks the last recorded Web Notification (like a click on the Edge popup). */
export async function clickLastToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = (window as unknown as RecordingWindow).__e2eToastObjects;
    list.at(-1)?.dispatchEvent(new Event('click', { cancelable: true }));
  });
}

export function tones(page: Page): Promise<RecordedTone[]> {
  return page.evaluate(() => (window as unknown as RecordingWindow).__e2eTones);
}
