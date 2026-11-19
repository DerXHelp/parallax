import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getZoom, resetZoomState } from '@web/state/zoom';
import { resetClientStore } from '@web/state/store';
import { ShortcutRegistry } from './shortcuts';
import { WHEEL_IDLE_MS, WHEEL_STEP_PX, installZoomInput, zoomKeyAction } from './zoom-input';

let registry: ShortcutRegistry;
let cleanup: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  registry = new ShortcutRegistry();
  cleanup = installZoomInput(window, registry);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetZoomState();
  resetClientStore();
});

function key(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

/** A Ctrl+wheel event (happy-dom's WheelEvent has no `ctrlKey` – Chrome's extends MouseEvent). */
function wheelEvent(deltaY: number, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...init });
  Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey ?? true });
  return event;
}

function wheel(deltaY: number, init: WheelEventInit = {}): WheelEvent {
  const event = wheelEvent(deltaY, init);
  document.body.dispatchEvent(event);
  return event;
}

describe('zoom keys and wheel (WP-92)', () => {
  it('maps Ctrl+Plus/Minus/0 of every layout and the numpad; AltGr and plain keys are no zoom keys', () => {
    const action = (init: KeyboardEventInit) => zoomKeyAction(new KeyboardEvent('keydown', init));
    expect(action({ key: '+', ctrlKey: true })).toBe('in');
    expect(action({ key: '=', ctrlKey: true })).toBe('in');
    expect(action({ key: '+', code: 'NumpadAdd', ctrlKey: true })).toBe('in');
    expect(action({ key: '-', ctrlKey: true })).toBe('out');
    expect(action({ key: '-', code: 'NumpadSubtract', ctrlKey: true })).toBe('out');
    expect(action({ key: '0', ctrlKey: true })).toBe('reset');
    // Shifted plus/minus keys (Chrome zooms on them too): German `*` from the plus key, `_`.
    expect(action({ key: '*', code: 'BracketRight', ctrlKey: true, shiftKey: true })).toBe('in');
    expect(action({ key: '_', code: 'Slash', ctrlKey: true, shiftKey: true })).toBe('out');
    expect(action({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true })).toBe('out');
    // Numpad `*` and German Ctrl+Shift+0 (`=`) are no zoom keys.
    expect(action({ key: '*', code: 'NumpadMultiply', ctrlKey: true })).toBeNull();
    expect(action({ key: '=', code: 'Digit0', ctrlKey: true, shiftKey: true })).toBeNull();
    expect(action({ key: '+' })).toBeNull();
    expect(action({ key: '+', ctrlKey: true, altKey: true })).toBeNull();
    expect(action({ key: 'k', ctrlKey: true })).toBeNull();
  });

  it('Ctrl+Plus/Minus step and prevent Chrome’s zoom; Ctrl+0 resets and lets Chrome reset as well', () => {
    expect(key({ key: '+', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(getZoom()).toBe(110);
    key({ key: '=', ctrlKey: true });
    expect(getZoom()).toBe(125);
    expect(key({ key: '-', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(getZoom()).toBe(110);
    expect(key({ key: '0', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(getZoom()).toBe(100);
    // Already handled elsewhere, or AltGr: nothing happens.
    const handled = new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    key({ key: '+', ctrlKey: true, altKey: true });
    expect(getZoom()).toBe(100);
  });

  it('works in text fields', () => {
    const input = document.createElement('textarea');
    document.body.append(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(getZoom()).toBe(110);
    input.remove();
  });

  it('Ctrl+wheel: one step per notch, up zooms in; Chrome’s zoom is prevented', () => {
    expect(wheel(-WHEEL_STEP_PX).defaultPrevented).toBe(true);
    expect(getZoom()).toBe(110);
    vi.advanceTimersByTime(WHEEL_IDLE_MS + 1);
    wheel(WHEEL_STEP_PX);
    expect(getZoom()).toBe(100);
    vi.advanceTimersByTime(WHEEL_IDLE_MS + 1);
    wheel(3, { deltaMode: 1 });
    expect(getZoom()).toBe(90);
  });

  it('a touchpad pinch (many small Ctrl+wheel events) moves step by step', () => {
    for (let i = 0; i < 24; i++) {
      expect(wheel(-5).defaultPrevented).toBe(true);
      vi.advanceTimersByTime(10);
    }
    expect(getZoom()).toBe(110);
    // A pause starts over: the remaining delta does not add up with the next gesture.
    vi.advanceTimersByTime(WHEEL_IDLE_MS + 1);
    for (let i = 0; i < 19; i++) wheel(-5);
    expect(getZoom()).toBe(110);
    wheel(-5);
    expect(getZoom()).toBe(125);
  });

  it('leaves plain wheel events and ones handled further in (the lightbox) alone', () => {
    expect(wheel(-WHEEL_STEP_PX, { ctrlKey: false }).defaultPrevented).toBe(false);
    const inner = document.createElement('div');
    document.body.append(inner);
    inner.addEventListener('wheel', (event) => {
      event.preventDefault();
    });
    inner.dispatchEvent(wheelEvent(-WHEEL_STEP_PX));
    expect(getZoom()).toBe(100);
    inner.remove();
  });

  it('lists the zoom in the ? help (also in text fields) and removes the entries again', () => {
    expect(registry.list().map((entry) => [entry.id, entry.keys, entry.allowInInputs])).toEqual([
      ['shell.zoom.wheel', 'Mod+Wheel', true],
      ['shell.zoom.in', 'Mod+Plus', true],
      ['shell.zoom.out', 'Mod+Minus', true],
      ['shell.zoom.reset', 'Mod+0', true],
    ]);
    cleanup();
    cleanup = () => undefined;
    expect(registry.list()).toEqual([]);
    key({ key: '+', ctrlKey: true });
    expect(getZoom()).toBe(100);
  });
});
