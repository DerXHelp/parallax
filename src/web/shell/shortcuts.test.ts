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
  it('window-wide shortcuts sleep while a dialog or menu is open, scoped ones keep working (R4W-11)', () => {
    const registry = new ShortcutRegistry();
    const select = vi.fn(() => true);
    const scoped = vi.fn(() => true);
    registry.register({
      id: 'select',
      keys: 'Alt+2',
      description: 'shell.shortcuts.selectSession',
      run: select,
    });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.dataset.state = 'open';
    dialog.dataset.shortcutScope = 'in-dialog';
    const field = document.createElement('button');
    dialog.append(field);
    registry.register({
      id: 'scoped',
      keys: 'Alt+3',
      description: 'shell.shortcuts.selectSession',
      scope: 'in-dialog',
      run: scoped,
    });
    document.body.append(dialog);
    try {
      expect(registry.handleKeyDown(key({ key: '2', altKey: true }, field))).toBe(false);
      expect(select).not.toHaveBeenCalled();
      expect(registry.handleKeyDown(key({ key: '3', altKey: true }, field))).toBe(true);
      expect(scoped).toHaveBeenCalledOnce();
      // Closing (Radix: data-state="closed" during the exit animation) wakes them up again.
      dialog.dataset.state = 'closed';
      expect(registry.handleKeyDown(key({ key: '2', altKey: true }))).toBe(true);
      expect(select).toHaveBeenCalledOnce();
    } finally {
      dialog.remove();
    }
  });

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

describe('Esc with event and scope, scopeRef, Alt codes (R1W-06, R1W-16)', () => {
  function pane(name: string) {
    const root = document.createElement('section');
    root.dataset.name = name;
    const composer = document.createElement('textarea');
    composer.dataset.shortcutScope = 'composer';
    const other = document.createElement('button');
    root.append(composer, other);
    document.body.append(root);
    return { root, composer, other };
  }

  it('passes the event and runs scoped Esc handlers only with the focus inside the scope', () => {
    const registry = new ShortcutRegistry();
    const a = pane('a');
    const stop = vi.fn((event: KeyboardEvent) => event.target === a.composer);
    registry.pushEscape(stop, { scope: 'composer' });
    // Focus elsewhere (transcript, sidebar): the stop handler does not run.
    expect(registry.handleKeyDown(key({ key: 'Escape' }, a.other))).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    const event = key({ key: 'Escape' }, a.composer);
    expect(registry.handleKeyDown(event)).toBe(true);
    expect(stop).toHaveBeenCalledWith(event);
    a.root.remove();
  });

  it('scopeRef picks the handler of the pane that has the focus (two panes, same scope name)', () => {
    const registry = new ShortcutRegistry();
    const a = pane('a');
    const b = pane('b');
    const calls: string[] = [];
    registry.register({
      id: 'decision.allow',
      keys: 'y',
      description: 'shell.shortcuts.help',
      scopeRef: { current: a.root },
      run: () => {
        calls.push('a');
        return true;
      },
    });
    registry.register({
      id: 'decision.allow',
      keys: 'y',
      description: 'shell.shortcuts.help',
      scopeRef: { current: b.root },
      run: () => {
        calls.push('b');
        return true;
      },
    });
    registry.pushEscape(
      () => {
        calls.push('esc-a');
        return true;
      },
      { scopeRef: { current: a.root } },
    );
    expect(registry.handleKeyDown(key({ key: 'y' }, a.other))).toBe(true);
    expect(registry.handleKeyDown(key({ key: 'y' }, b.other))).toBe(true);
    expect(registry.handleKeyDown(key({ key: 'Escape' }, b.other))).toBe(false);
    expect(registry.handleKeyDown(key({ key: 'Escape' }, a.other))).toBe(true);
    expect(calls).toEqual(['a', 'b', 'esc-a']);
    a.root.remove();
    b.root.remove();
  });

  it('never treats Alt+Numpad digits (Windows Alt codes) as shortcuts', () => {
    const alt1 = parseShortcut('Alt+1');
    expect(
      matchesShortcut(
        { key: '1', code: 'Numpad1', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
        alt1,
      ),
    ).toBe(false);
    expect(
      matchesShortcut(
        { key: '1', code: 'Digit1', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false },
        alt1,
      ),
    ).toBe(true);
  });
});
