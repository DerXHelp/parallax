import type { ITheme } from '@xterm/xterm';

/**
 * Colours of the terminal (WP-99b): the design tokens `--terminal-*` of index.css (hex, light and
 * dark) read from the computed style into an xterm `ITheme`. The theme switches through the class
 * `dark` on `<html>` (state/theme.ts), so `watchTerminalTheme` observes that class.
 */

type ThemeColor = Exclude<keyof ITheme, 'extendedAnsi'>;

/** xterm colour → design token. */
export const TERMINAL_THEME_TOKENS: readonly (readonly [ThemeColor, string])[] = [
  ['background', '--terminal-background'],
  ['foreground', '--terminal-foreground'],
  ['cursor', '--terminal-cursor'],
  ['cursorAccent', '--terminal-background'],
  ['selectionBackground', '--terminal-selection'],
  ['black', '--terminal-black'],
  ['red', '--terminal-red'],
  ['green', '--terminal-green'],
  ['yellow', '--terminal-yellow'],
  ['blue', '--terminal-blue'],
  ['magenta', '--terminal-magenta'],
  ['cyan', '--terminal-cyan'],
  ['white', '--terminal-white'],
  ['brightBlack', '--terminal-bright-black'],
  ['brightRed', '--terminal-bright-red'],
  ['brightGreen', '--terminal-bright-green'],
  ['brightYellow', '--terminal-bright-yellow'],
  ['brightBlue', '--terminal-bright-blue'],
  ['brightMagenta', '--terminal-bright-magenta'],
  ['brightCyan', '--terminal-bright-cyan'],
  ['brightWhite', '--terminal-bright-white'],
];

/** The theme from the tokens in effect at `element` (a missing token keeps xterm's default). */
export function readTerminalTheme(element: Element = document.documentElement): ITheme {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const theme: ITheme = {};
  if (style === undefined) return theme;
  for (const [color, token] of TERMINAL_THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim();
    if (value !== '') theme[color] = value;
  }
  return theme;
}

function themeKey(theme: ITheme): string {
  return TERMINAL_THEME_TOKENS.map(([color]) => theme[color] ?? '').join('|');
}

/**
 * Calls `onChange` with the new theme whenever the class of `root` changes the tokens (light ↔
 * dark); returns the cleanup.
 */
export function watchTerminalTheme(
  onChange: (theme: ITheme) => void,
  root: HTMLElement = document.documentElement,
): () => void {
  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  if (Observer === undefined) return () => undefined;
  let last = themeKey(readTerminalTheme(root));
  const observer = new Observer(() => {
    const theme = readTerminalTheme(root);
    const key = themeKey(theme);
    if (key === last) return;
    last = key;
    onChange(theme);
  });
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
  };
}
