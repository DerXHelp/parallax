import { useEffect, useEffectEvent, useSyncExternalStore } from 'react';
import type { TranslationKey } from '@web/i18n';

/**
 * Central shortcut registry (Plan B "Tastatur"): one keydown listener on the window, a `?` help
 * (ShortcutHelp), no Ctrl+Alt combinations (AltGr on German layouts = Ctrl+Alt: `@ € { [ ] } \ ~ |`),
 * nothing on Ctrl+W/N/T (not catchable). Esc goes through a stack: the newest active handler
 * that returns true wins (e.g. WP-16 "Stop via Esc with an empty composer"); open Radix layers
 * (dialog, menu, popover) handle their own Esc first.
 *
 * Key syntax: `Mod+K` (Mod = Ctrl), `Alt+1`, `Shift+Enter`, `?`, `Escape`. Symbol keys (`?`, `/`)
 * match regardless of Shift (layout-dependent).
 */

export interface ShortcutKeys {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ShortcutDefinition {
  id: string;
  /** One combination or several (the handler gets the index of the matching one). */
  keys: string | readonly string[];
  /** Help text (`?`). */
  description: TranslationKey;
  /** Shown in the help instead of `keys` (e.g. `Alt+1–9`). */
  displayKeys?: string;
  /** Also while the focus is in a text field (default false). */
  allowInInputs?: boolean;
  /** Only while the focus is inside `[data-shortcut-scope="<scope>"]` (e.g. the decision bar, Plan B). */
  scope?: string;
  /** Not listed in the help. */
  hidden?: boolean;
  /** Return `false` if not handled (the event then continues). */
  run(event: KeyboardEvent, index: number): boolean | undefined;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};

function normalizeKey(key: string): string {
  if (key.length === 1) return key.toLowerCase();
  return NAMED_KEYS[key.toLowerCase()] ?? key;
}

function isSymbol(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/i.test(key);
}

/** Parses `Mod+Shift+K`; throws for Ctrl+Alt combinations and empty keys. */
export function parseShortcut(combo: string): ShortcutKeys {
  const parts = combo.split('+').map((part) => part.trim());
  const key = parts.pop();
  if (key === undefined || key === '') throw new Error(`Invalid shortcut "${combo}"`);
  const result: ShortcutKeys = { key: normalizeKey(key), ctrl: false, alt: false, shift: false, meta: false };
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case 'mod':
      case 'ctrl':
      case 'control':
        result.ctrl = true;
        break;
      case 'alt':
        result.alt = true;
        break;
      case 'shift':
        result.shift = true;
        break;
      case 'meta':
      case 'win':
        result.meta = true;
        break;
      default:
        throw new Error(`Unknown modifier "${modifier}" in shortcut "${combo}"`);
    }
  }
  if (result.ctrl && result.alt) {
    throw new Error(`Ctrl+Alt shortcuts are not allowed (AltGr on German layouts): "${combo}"`);
  }
  return result;
}

export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function matchesShortcut(event: KeyboardEventLike, keys: ShortcutKeys): boolean {
  // AltGr arrives as Ctrl+Alt – never a shortcut.
  if (event.ctrlKey && event.altKey) return false;
  const key = normalizeKey(event.key);
  if (key !== keys.key) return false;
  if (event.ctrlKey !== keys.ctrl || event.altKey !== keys.alt || event.metaKey !== keys.meta) return false;
  return isSymbol(key) || event.shiftKey === keys.shift;
}

function isEditable(target: Element | null): boolean {
  if (target === null) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
      target.type,
    );
  }
  return false;
}

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

interface Registered {
  definition: ShortcutDefinition;
  parsed: ShortcutKeys[];
}

export class ShortcutRegistry {
  private readonly entries: Registered[] = [];
  private readonly escapeStack: { handler: () => boolean }[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Registers a shortcut; later registrations win. Returns the unregister function. */
  register(definition: ShortcutDefinition): () => void {
    const combos = typeof definition.keys === 'string' ? [definition.keys] : definition.keys;
    const entry: Registered = { definition, parsed: combos.map(parseShortcut) };
    this.entries.push(entry);
    this.changed();
    return () => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) {
        this.entries.splice(index, 1);
        this.changed();
      }
    };
  }

  /** Visible shortcuts for the help, in registration order (one per id). */
  list(): ShortcutDefinition[] {
    const seen = new Set<string>();
    const result: ShortcutDefinition[] = [];
    for (const { definition } of this.entries) {
      if (definition.hidden === true || seen.has(definition.id)) continue;
      seen.add(definition.id);
      result.push(definition);
    }
    return result;
  }

  /** Pushes an Esc handler (returns true if it handled the key). Returns the remove function. */
  pushEscape(handler: () => boolean): () => void {
    const entry = { handler };
    this.escapeStack.push(entry);
    return () => {
      const index = this.escapeStack.indexOf(entry);
      if (index >= 0) this.escapeStack.splice(index, 1);
    };
  }

  /** The window keydown handler; true if a shortcut handled the event (preventDefault was called). */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if ((target?.closest(OVERLAY_SELECTOR) ?? null) !== null) return false;
      for (let i = this.escapeStack.length - 1; i >= 0; i--) {
        if (this.escapeStack[i]?.handler() === true) {
          event.preventDefault();
          return true;
        }
      }
    }
    const typing = isEditable(target);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      const { definition } = entry;
      if (typing && definition.allowInInputs !== true) continue;
      if (definition.scope !== undefined) {
        const scoped = target?.closest(`[data-shortcut-scope="${definition.scope}"]`) ?? null;
        if (scoped === null) continue;
      }
      const index = entry.parsed.findIndex((keys) => matchesShortcut(event, keys));
      if (index < 0) continue;
      if (definition.run(event, index) !== false) {
        event.preventDefault();
        return true;
      }
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  private changed(): void {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The registry of this window. */
export const shortcuts = new ShortcutRegistry();

/** Installs the one keydown listener (main.tsx / playground); returns the cleanup. */
export function installShortcutListener(
  registry: ShortcutRegistry = shortcuts,
  target: Window = window,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    registry.handleKeyDown(event);
  };
  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}

/** Registers a shortcut while mounted; `run` always sees the latest props. */
export function useShortcut(definition: ShortcutDefinition, enabled = true): void {
  const run = useEffectEvent((event: KeyboardEvent, index: number) => definition.run(event, index));
  const { id, description, displayKeys, allowInInputs, scope, hidden } = definition;
  const keys = typeof definition.keys === 'string' ? definition.keys : definition.keys.join('\n');
  useEffect(() => {
    if (!enabled) return undefined;
    return shortcuts.register({
      id,
      keys: keys.split('\n'),
      description,
      displayKeys,
      allowInInputs,
      scope,
      hidden,
      run: (event, index) => run(event, index),
    });
  }, [enabled, id, keys, description, displayKeys, allowInInputs, scope, hidden]);
}

/** Esc handler while mounted and `enabled` (return true = handled, stops the stack). */
export function useEscapeHandler(handler: () => boolean, enabled = true): void {
  const run = useEffectEvent(() => handler());
  useEffect(() => {
    if (!enabled) return undefined;
    return shortcuts.pushEscape(() => run());
  }, [enabled]);
}

function subscribeShortcuts(listener: () => void): () => void {
  return shortcuts.subscribe(listener);
}

function shortcutsVersion(): number {
  return shortcuts.getVersion();
}

/** Re-renders when shortcuts are (un)registered; returns the visible list. */
export function useShortcutList(): ShortcutDefinition[] {
  useSyncExternalStore(subscribeShortcuts, shortcutsVersion, shortcutsVersion);
  return shortcuts.list();
}

const KEY_LABELS: Readonly<Record<string, TranslationKey>> = {
  mod: 'common.keys.ctrl',
  ctrl: 'common.keys.ctrl',
  control: 'common.keys.ctrl',
  alt: 'common.keys.alt',
  shift: 'common.keys.shift',
  meta: 'common.keys.meta',
  win: 'common.keys.meta',
  esc: 'common.keys.escape',
  escape: 'common.keys.escape',
  enter: 'common.keys.enter',
  space: 'common.keys.space',
  tab: 'common.keys.tab',
  backspace: 'common.keys.backspace',
  up: 'common.keys.arrowUp',
  arrowup: 'common.keys.arrowUp',
  down: 'common.keys.arrowDown',
  arrowdown: 'common.keys.arrowDown',
  left: 'common.keys.arrowLeft',
  arrowleft: 'common.keys.arrowLeft',
  right: 'common.keys.arrowRight',
  arrowright: 'common.keys.arrowRight',
};

/** Translated key caps of a combination: `Mod+K` → ['Strg', 'K'] in German. */
export function shortcutKeyLabels(combo: string, t: (key: TranslationKey) => string): string[] {
  return combo.split('+').map((part) => {
    const trimmed = part.trim();
    const label = KEY_LABELS[trimmed.toLowerCase()];
    if (label !== undefined) return t(label);
    return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed;
  });
}
