import { describe, expect, it, vi } from 'vitest';
import { APP_KEYS, createTerminalKeyHandler, terminalKeyAction } from './keys';

function key(init: KeyboardEventInit & { key: string }, type = 'keydown'): KeyboardEvent {
  return new KeyboardEvent(type, { cancelable: true, bubbles: true, ...init });
}

function handler(selection = '') {
  const state = { selection };
  const copySelection = vi.fn(() => {
    state.selection = '';
  });
  const handle = createTerminalKeyHandler({ hasSelection: () => state.selection !== '', copySelection });
  return { handle, copySelection, state };
}

describe('terminal keys (WP-99b)', () => {
  it('hands the app shortcuts and the zoom keys back to the app', () => {
    const { handle } = handler();
    for (const combo of [
      { key: 't', altKey: true },
      { key: 'k', altKey: true },
      { key: 'n', altKey: true },
      { key: '1', altKey: true, code: 'Digit1' },
      { key: '9', altKey: true, code: 'Digit9' },
      { key: '+', ctrlKey: true },
      { key: '=', ctrlKey: true, code: 'Equal' },
      { key: '-', ctrlKey: true },
      { key: '0', ctrlKey: true, code: 'Digit0' },
    ]) {
      const event = key(combo);
      expect(handle(event), JSON.stringify(combo)).toBe(false);
      // Nothing handled here: the event bubbles on to the shortcut registry / zoom listener.
      expect(event.defaultPrevented).toBe(false);
    }
    expect(APP_KEYS).toContain('Alt+T');
  });

  it('Ctrl+C copies a selection (and clears it), without a selection it goes to the shell', () => {
    const withSelection = handler('dir output');
    const copy = key({ key: 'c', ctrlKey: true });
    expect(withSelection.handle(copy)).toBe(false);
    expect(copy.defaultPrevented).toBe(true);
    expect(withSelection.copySelection).toHaveBeenCalledTimes(1);
    // The keyup after the copy reaches xterm again (nothing selected any more).
    expect(withSelection.handle(key({ key: 'c', ctrlKey: true }, 'keyup'))).toBe(true);

    const without = handler();
    const interrupt = key({ key: 'c', ctrlKey: true });
    expect(without.handle(interrupt)).toBe(true);
    expect(interrupt.defaultPrevented).toBe(false);
    expect(without.copySelection).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+C always copies, never sends ^C', () => {
    const { handle, copySelection } = handler();
    const event = key({ key: 'C', ctrlKey: true, shiftKey: true });
    expect(handle(event)).toBe(false);
    expect(copySelection).not.toHaveBeenCalled();
    expect(terminalKeyAction(event, false)).toBe('copy');
  });

  it('Ctrl+V and Ctrl+Shift+V paste through the browser (no ^V, no preventDefault)', () => {
    const { handle } = handler();
    for (const combo of [
      { key: 'v', ctrlKey: true },
      { key: 'V', ctrlKey: true, shiftKey: true },
    ]) {
      const event = key(combo);
      expect(terminalKeyAction(event, false)).toBe('paste');
      expect(handle(event)).toBe(false);
      // The native paste event must still fire – xterm's paste handler inserts the text.
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('everything else stays in the terminal: Esc, Ctrl+K, Alt+B, F2, AltGr, Alt+Numpad', () => {
    const { handle } = handler();
    for (const combo of [
      { key: 'Escape' },
      { key: 'k', ctrlKey: true },
      { key: 'b', altKey: true },
      { key: 'F2' },
      { key: 'a' },
      { key: 'Enter' },
      // AltGr arrives as Ctrl+Alt (e.g. "@" on a German layout).
      { key: '@', ctrlKey: true, altKey: true, code: 'KeyQ' },
      // Alt+Numpad digits are Windows Alt codes, never "session 1".
      { key: '1', altKey: true, code: 'Numpad1' },
    ]) {
      expect(handle(key(combo)), JSON.stringify(combo)).toBe(true);
    }
  });
});
