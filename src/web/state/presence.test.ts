import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPresenceTracking, reportTyping, TYPING_WINDOW_MS } from './presence';
import { createClientStore } from './store';

/** Window presence for the server's channel choice (A.9): focus, visibility, typing. */

/** happy-dom may define it on the instance; restored after each test. */
const ownVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'visibilityState');
  if (ownVisibility !== undefined) Object.defineProperty(document, 'visibilityState', ownVisibility);
});

describe('startPresenceTracking', () => {
  it('follows window focus and page visibility until stopped', () => {
    const store = createClientStore();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const stop = startPresenceTracking(store);
    expect(store.getState().presence).toEqual({ focused: true, visible: true, typing: false });

    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(store.getState().presence.focused).toBe(false);

    setVisibility('hidden');
    expect(store.getState().presence.visible).toBe(false);

    hasFocus.mockReturnValue(true);
    setVisibility('visible');
    window.dispatchEvent(new Event('focus'));
    expect(store.getState().presence).toEqual({ focused: true, visible: true, typing: false });

    stop();
    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    expect(store.getState().presence.focused).toBe(true);
  });

  it('reportTyping keeps `typing` for 5 s after the last key stroke', () => {
    vi.useFakeTimers();
    const store = createClientStore();
    reportTyping(store);
    expect(store.getState().presence.typing).toBe(true);
    vi.advanceTimersByTime(TYPING_WINDOW_MS - 1);
    reportTyping(store);
    vi.advanceTimersByTime(TYPING_WINDOW_MS - 1);
    expect(store.getState().presence.typing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.getState().presence.typing).toBe(false);
  });
});
