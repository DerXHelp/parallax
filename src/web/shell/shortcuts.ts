import { useEffect, useEffectEvent, useSyncExternalStore, type RefObject } from 'react';
import type { TranslationKey } from '@web/i18n';

/**
 * Central shortcut registry (Plan B "Tastatur"): one keydown listener on the window, a `?` help
 * (ShortcutHelp), no Ctrl+Alt combinations (AltGr on German layouts = Ctrl+Alt: `@ € { [ ] } \ ~ |`),
 * nothing on Ctrl+W/N/T (not catchable), Alt+Numpad digits stay Windows Alt codes. Esc goes
 * through a stack: the newest active handler whose scope contains the focus and that returns true
 * wins (e.g. WP-16 "Stop via Esc with an empty composer", scoped to the composer); open Radix
 * layers (dialog, menu, popover) handle their own Esc first.
 *
 * Scopes: `scope: 'decision-bar'` (focus inside `[data-shortcut-scope="decision-bar"]`, any pane)
 * or – exact with several panes – `scopeRef` (focus inside that element). Both may be combined.
 * While a dialog or menu is open, only scoped shortcuts fire (R4W-11).
 *
 * Key syntax: `Mod+K` (Mod = Ctrl), `Alt+1`, `Shift+Enter`, `?`, `Escape`. Symbol keys (`?`, `/`)
 * match regardless of Shift (layout-dependent).
 */

/** Where the focus must be for a shortcut or Esc handler to fire. */
export interface ShortcutScope {
  /** Focus inside `[data-shortcut-scope="<scope>"]`. */
  scope?: string;
  /** Focus inside this element (e.g. the decision bar of THIS pane, R1W-06). */
  scopeRef?: RefObject<HTMLElement | null>;
}

export interface ShortcutKeys {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ShortcutDefinition extends ShortcutScope {
  id: string;
  /** One combination or several (the handler gets the index of the matching one). */
  keys: string | readonly string[];
  /** Help text (`?`). */
  description: TranslationKey;
  /** Shown in the help instead of `keys` (e.g. `Alt+1–9`). */
  displayKeys?: string;
  /** Also while the focus is in a text field (default false). */
  allowInInputs?: boolean;
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
  /** Physical key (`Numpad1` …); optional for synthetic events. */
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export function matchesShortcut(event: KeyboardEventLike, keys: ShortcutKeys): boolean {
  // AltGr arrives as Ctrl+Alt – never a shortcut.
  if (event.ctrlKey && event.altKey) return false;
  // Alt+Numpad digits type Windows Alt codes (Alt+0169 = ©) – never a shortcut (R1W-16).
  if (event.altKey && event.code?.startsWith('Numpad') === true) return false;
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

/** An open dialog, alert dialog or menu anywhere in the document (Radix marks it `data-state="open"`). */
const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';

function overlayOpen(target: Element | null): boolean {
  const doc = target?.ownerDocument ?? (typeof document === 'undefined' ? null : document);
  return doc !== null && doc.querySelector(OPEN_OVERLAY_SELECTOR) !== null;
}

interface Registered {
  definition: ShortcutDefinition;
  parsed: ShortcutKeys[];
}

/** Esc handler: return true if it handled the key (stops the stack, preventDefault). */
export type EscapeHandler = (event: KeyboardEvent) => boolean;

interface EscapeEntry {
  handler: EscapeHandler;
  scope: ShortcutScope;
}

/** True when the focus (`target`) satisfies the scope (no scope = everywhere). */
export function isInScope(target: Element | null, scope: ShortcutScope): boolean {
  if (scope.scope !== undefined) {
    if ((target?.closest(`[data-shortcut-scope="${scope.scope}"]`) ?? null) === null) return false;
  }
  if (scope.scopeRef !== undefined) {
    const element = scope.scopeRef.current;
    if (element === null || target === null || !element.contains(target)) return false;
  }
  return true;
}

export class ShortcutRegistry {
  private readonly entries: Registered[] = [];
  private readonly escapeStack: EscapeEntry[] = [];
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

  /**
   * Pushes an Esc handler; it only runs while the focus is inside `scope` (none = everywhere).
   * Returns the remove function.
   */
  pushEscape(handler: EscapeHandler, scope: ShortcutScope = {}): () => void {
    const entry: EscapeEntry = { handler, scope };
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
        const entry = this.escapeStack[i];
        if (entry === undefined || !isInScope(target, entry.scope)) continue;
        if (entry.handler(event)) {
          event.preventDefault();
          return true;
        }
      }
    }
    const typing = isEditable(target);
    // R4W-11: window-wide shortcuts sleep while a dialog or menu is open (Alt+2 would switch the
    // session behind the settings, Ctrl+K stack the switcher on top); scoped ones still fire
    // when the focus is inside their scope.
    const overlay = overlayOpen(target);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      const { definition } = entry;
      if (typing && definition.allowInInputs !== true) continue;
      if (overlay && definition.scope === undefined && definition.scopeRef === undefined) continue;
      if (!isInScope(target, definition)) continue;
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
  const { id, description, displayKeys, allowInInputs, scope, scopeRef, hidden } = definition;
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
      scopeRef,
      hidden,
      run: (event, index) => run(event, index),
    });
  }, [enabled, id, keys, description, displayKeys, allowInInputs, scope, scopeRef, hidden]);
}

/**
 * Esc handler while mounted and `enabled`: gets the event (target = focused element) and returns
 * true when it handled the key (stops the stack). With `scope`/`scopeRef` it only runs while the
 * focus is inside that scope – e.g. WP-16 "Stop via Esc" only with the focus in the composer of
 * the same pane (R1W-06).
 */
export function useEscapeHandler(handler: EscapeHandler, enabled = true, options: ShortcutScope = {}): void {
  const run = useEffectEvent((event: KeyboardEvent) => handler(event));
  const { scope, scopeRef } = options;
  useEffect(() => {
    if (!enabled) return undefined;
    return shortcuts.pushEscape((event) => run(event), { scope, scopeRef });
  }, [enabled, scope, scopeRef]);
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
