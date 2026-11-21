import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { clampTerminalSize, type TerminalSize } from './size';

/**
 * The terminal engine behind `TerminalView` (WP-99b): a small adapter around xterm.js, so the view
 * never touches xterm directly and tests run with `FakeEngine` (happy-dom cannot lay out xterm).
 * xterm (DOM renderer only – no WebGL or canvas addon) and its CSS live in the lazy panel chunk:
 * only modules of that chunk import this file.
 */

export interface TerminalFont {
  /** CSS `font-family` list (the computed value of the app's mono font). */
  family: string;
  /** px (follows the app zoom). */
  size: number;
}

export interface EngineOptions {
  theme: ITheme;
  font: TerminalFont;
  screenReaderMode: boolean;
  /**
   * The session's computer runs Windows: its pseudo console is ConPTY (`windowsPty`). WP-104: false
   * for a Linux computer, whose pty reflows nothing itself.
   */
  conpty: boolean;
}

/** xterm's custom key handler: return false and xterm ignores the event (it bubbles on). */
export type TerminalKeyHandler = (event: KeyboardEvent) => boolean;

export interface TerminalEngine {
  /** Renders into `host` (once; later calls do nothing). */
  open(host: HTMLElement): void;
  /** Output: UTF-8 bytes (may end inside a sequence – decoded as a stream) or text. */
  write(data: Uint8Array | string): void;
  /** Clears screen and scrollback (before the replay of an `attach`). */
  reset(): void;
  /** Clears the scrollback and keeps the prompt line (menu "Clear"). */
  clear(): void;
  /** Keys and pastes the user typed; returns the unsubscribe function. */
  onData(listener: (data: string) => void): () => void;
  /** Fits columns and rows to the host; null while the host has no size (hidden, not opened). */
  fit(): TerminalSize | null;
  readonly size: TerminalSize;
  focus(): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  selectAll(): void;
  /** Like a paste of the user (bracketed paste when the shell asked for it). */
  paste(text: string): void;
  setTheme(theme: ITheme): void;
  setFont(font: TerminalFont): void;
  setScreenReaderMode(enabled: boolean): void;
  setKeyHandler(handler: TerminalKeyHandler): void;
  dispose(): void;
}

export type EngineFactory = (options: EngineOptions) => TerminalEngine;

/** Lines kept above the screen in the browser (the server keeps its own replay buffer). */
export const SCROLLBACK_LINES = 5000;

/** True for an absolute http(s) URL – the only links the terminal opens. */
export function isWebLink(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The real engine: xterm.js with the fit addon. */
export const createXtermEngine: EngineFactory = (options) => {
  const terminal = new Terminal({
    fontFamily: options.font.family,
    fontSize: options.font.size,
    theme: options.theme,
    screenReaderMode: options.screenReaderMode,
    cursorBlink: true,
    scrollback: SCROLLBACK_LINES,
    // ConPTY reflows lines itself; xterm adapts its own reflow and wrapping heuristics to it – only
    // on a Windows computer (WP-104).
    ...(options.conpty ? { windowsPty: { backend: 'conpty' as const } } : {}),
    // OSC 8 links: http(s) only, opened like the transcript's links. Without a handler xterm asks
    // with its blocking `confirm()` (the app's dialogs are never modal).
    linkHandler: {
      allowNonHttpProtocols: false,
      activate: (_event, uri) => {
        if (isWebLink(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
      },
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  let host: HTMLElement | null = null;

  return {
    open(element) {
      if (host !== null) return;
      host = element;
      terminal.open(element);
    },
    write(data) {
      terminal.write(data);
    },
    reset() {
      terminal.reset();
    },
    clear() {
      terminal.clear();
    },
    onData(listener) {
      const subscription = terminal.onData(listener);
      return () => {
        subscription.dispose();
      };
    },
    fit() {
      if (host === null || host.clientWidth === 0 || host.clientHeight === 0) return null;
      const proposed = fitAddon.proposeDimensions();
      if (proposed === undefined || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
        return null;
      }
      const size = clampTerminalSize(proposed);
      if (size.cols === proposed.cols && size.rows === proposed.rows) fitAddon.fit();
      else if (size.cols !== terminal.cols || size.rows !== terminal.rows)
        terminal.resize(size.cols, size.rows);
      return { cols: terminal.cols, rows: terminal.rows };
    },
    get size() {
      return { cols: terminal.cols, rows: terminal.rows };
    },
    focus() {
      terminal.focus();
    },
    hasSelection() {
      return terminal.hasSelection();
    },
    getSelection() {
      return terminal.getSelection();
    },
    clearSelection() {
      terminal.clearSelection();
    },
    selectAll() {
      terminal.selectAll();
    },
    paste(text) {
      terminal.paste(text);
    },
    setTheme(theme) {
      terminal.options.theme = theme;
    },
    setFont(font) {
      terminal.options.fontFamily = font.family;
      terminal.options.fontSize = font.size;
    },
    setScreenReaderMode(enabled) {
      terminal.options.screenReaderMode = enabled;
    },
    setKeyHandler(handler) {
      terminal.attachCustomKeyEventHandler(handler);
    },
    dispose() {
      terminal.dispose();
      host = null;
    },
  };
};
