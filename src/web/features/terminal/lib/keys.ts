import { matchesShortcut, parseShortcut } from '@web/shell/shortcuts';
import { zoomKeyAction } from '@web/shell/zoom-input';
import type { TerminalKeyHandler } from './engine';

/**
 * Keys inside a terminal (WP-99b): xterm gets almost everything – also Esc, Ctrl+K (readline: kill
 * line), Alt+B/Alt+F (readline: word left/right) and the F-keys. Only these go back to the app:
 *
 * - App shortcuts registered with `allowInInputs` that make sense from a terminal: Alt+T (terminal),
 *   Alt+K (shell window), Alt+N (next waiting session), Alt+1…9 (sessions). The handler returns
 *   false, xterm ignores the key and it bubbles to the shortcut registry on the window.
 * - The zoom keys Ctrl+Plus/Minus/0 (`shell/zoom-input.ts`).
 * - Ctrl+C with a selection copies it (and clears it, so the next Ctrl+C interrupts again);
 *   without a selection it goes to the shell as ^C. Ctrl+Shift+C always copies.
 * - Ctrl+V / Ctrl+Shift+V paste: xterm skips the key (no ^V), the browser fires its native `paste`
 *   event and xterm's paste handler inserts the text (bracketed paste) – no clipboard permission.
 *
 * The only F-key of the app (F2 "Rename") is not registered for text fields, so it never fires from
 * the terminal anyway and stays with the shell.
 */

/** App shortcuts that pass through a terminal (`allowInInputs` in the registry). */
export const APP_KEYS = [
  'Alt+T',
  'Alt+K',
  'Alt+N',
  'Alt+1',
  'Alt+2',
  'Alt+3',
  'Alt+4',
  'Alt+5',
  'Alt+6',
  'Alt+7',
  'Alt+8',
  'Alt+9',
] as const;

const APP_SHORTCUTS = APP_KEYS.map(parseShortcut);

/** app = back to the app, copy/paste = clipboard, terminal = xterm handles it. */
export type TerminalKeyAction = 'app' | 'copy' | 'paste' | 'terminal';

export function terminalKeyAction(event: KeyboardEvent, hasSelection: boolean): TerminalKeyAction {
  if (zoomKeyAction(event) !== null) return 'app';
  if (APP_SHORTCUTS.some((keys) => matchesShortcut(event, keys))) return 'app';
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    const key = event.key.toLowerCase();
    if (key === 'c' && (hasSelection || event.shiftKey)) return 'copy';
    if (key === 'v') return 'paste';
  }
  return 'terminal';
}

export interface TerminalKeyDeps {
  hasSelection(): boolean;
  /** Copies the selection and clears it. */
  copySelection(): void;
}

/** xterm's custom key handler (called for keydown, keypress and keyup). */
export function createTerminalKeyHandler(deps: TerminalKeyDeps): TerminalKeyHandler {
  return (event) => {
    const action = terminalKeyAction(event, deps.hasSelection());
    if (action === 'terminal') return true;
    if (action === 'copy' && event.type === 'keydown') {
      event.preventDefault();
      if (deps.hasSelection()) deps.copySelection();
    }
    return false;
  };
}
