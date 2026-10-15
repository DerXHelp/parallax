import { describe, expect, it, vi } from 'vitest';
import { translate } from '@web/i18n';
import { ShortcutRegistry, matchesShortcut, parseShortcut, shortcutKeyLabels } from './shortcuts';

function key(init: KeyboardEventInit & { key: string }, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('parseShortcut / matchesShortcut', () => {
  it('rejects Ctrl+Alt combinations (AltGr on German layouts)', () => {
    expect(() => parseShortcut('Ctrl+Alt+K')).toThrow(/Ctrl\+Alt/);
    expect(() => parseShortcut('Mod+Alt+1')).toThrow(/Ctrl\+Alt/);
    expect(() => parseShortcut('Hyper+K')).toThrow(/Unknown modifier/);
  });

  it('matches modifiers exactly, symbols regardless of Shift, never AltGr', () => {
    expect(
      matchesShortcut(
        { key: 'k', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
        parseShortcut('Mod+K'),
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: 'K', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
        parseShortcut('Mod+K'),
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        { key: '?', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false },
        parseShortcut('?'),
      ),
    ).toBe(true);
    expect(
      matchesShortcut(
        { key: '1', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
        parseShortcut('Alt+1'),
      ),
    ).toBe(true);
    // AltGr+Q = "@" arrives as Ctrl+Alt: never a shortcut.
    expect(
      matchesShortcut(
        { key: '@', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false },
        parseShortcut('@'),
      ),
    ).toBe(false);
  });

  it('translates key caps', () => {
    expect(shortcutKeyLabels('Mod+Shift+K', (k) => translate('de', k))).toEqual(['Strg', 'Umschalt', 'K']);
    expect(shortcutKeyLabels('Alt+1–9', (k) => translate('en', k))).toEqual(['Alt', '1–9']);
  });
});

describe('ShortcutRegistry', () => {
  it('runs the newest matching shortcut and passes the index of the combination', () => {
    const registry = new ShortcutRegistry();
    const run = vi.fn(() => true);
    registry.register({
      id: 'select',
      keys: ['Alt+1', 'Alt+2'],
      description: 'shell.shortcuts.selectSession',
      run,
    });
    const event = key({ key: '2', altKey: true });
    expect(registry.handleKeyDown(event)).toBe(true);
    expect(run).toHaveBeenCalledWith(event, 1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('skips text fields unless allowed, and respects scopes', () => {
    const registry = new ShortcutRegistry();
    const help = vi.fn(() => true);
    const scoped = vi.fn(() => true);
    registry.register({ id: 'help', keys: '?', description: 'shell.shortcuts.help', run: help });
    registry.register({
      id: 'bar',
      keys: 'a',
      scope: 'decision-bar',
      description: 'shell.shortcuts.help',
      run: scoped,
    });
    const input = document.createElement('textarea');
    document.body.append(input);
    expect(registry.handleKeyDown(key({ key: '?', shiftKey: true }, input))).toBe(false);
    expect(registry.handleKeyDown(key({ key: '?', shiftKey: true }))).toBe(true);
    expect(registry.handleKeyDown(key({ key: 'a' }))).toBe(false);
    const bar = document.createElement('div');
    bar.dataset.shortcutScope = 'decision-bar';
    const button = document.createElement('button');
    bar.append(button);
    document.body.append(bar);
    expect(registry.handleKeyDown(key({ key: 'a' }, button))).toBe(true);
    expect(scoped).toHaveBeenCalledTimes(1);
    input.remove();
    bar.remove();
  });

  it('handles Esc through a stack (newest first) but not inside open overlays', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    const removeOuter = registry.pushEscape(() => {
      calls.push('outer');
      return true;
    });
    registry.pushEscape(() => {
      calls.push('inner (not handled)');
      return false;
    });
    expect(registry.handleKeyDown(key({ key: 'Escape' }))).toBe(true);
    expect(calls).toEqual(['inner (not handled)', 'outer']);

    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inside = document.createElement('button');
    dialog.append(inside);
    document.body.append(dialog);
    expect(registry.handleKeyDown(key({ key: 'Escape' }, inside))).toBe(false);
    dialog.remove();

    removeOuter();
    calls.length = 0;
    expect(registry.handleKeyDown(key({ key: 'Escape' }))).toBe(false);
  });

  it('lists visible shortcuts once per id and notifies on changes', () => {
    const registry = new ShortcutRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const remove = registry.register({
      id: 'a',
      keys: 'x',
      description: 'shell.shortcuts.help',
      run: () => true,
    });
    registry.register({ id: 'a', keys: 'y', description: 'shell.shortcuts.help', run: () => true });
    registry.register({
      id: 'hidden',
      keys: 'z',
      hidden: true,
      description: 'shell.shortcuts.help',
      run: () => true,
    });
    expect(registry.list().map((definition) => definition.id)).toEqual(['a']);
    remove();
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
