import { createContext, useContext } from 'react';
import type { HostId } from '@shared/common';
import { copyText } from '@web/lib/clipboard';
import { createXtermEngine, type EngineFactory, type TerminalFont } from '../lib/engine';
import { loadTerminalFont, terminalFontReady } from '../lib/font';
import { browserTerminalSocketFactory, terminalSocketUrl, type TerminalSocketFactory } from './socket';

/**
 * What the terminal panel needs from the browser (WP-99b), exchangeable for tests and the playground:
 * the engine (xterm or `FakeEngine`), the WebSocket, the clipboard and the font loading.
 */
export interface TerminalEnvironment {
  createEngine: EngineFactory;
  createSocket: TerminalSocketFactory;
  /** URL of the terminal socket of the session's computer (WP-105: another computer through the relay). */
  socketUrl(hostId: HostId): string;
  copyText(text: string): Promise<boolean>;
  /** Text of the clipboard (menu "Paste"); null when the browser refuses. */
  readClipboard(): Promise<string | null>;
  fontReady(font: TerminalFont): boolean;
  loadFont(font: TerminalFont): Promise<void>;
}

async function readClipboard(): Promise<string | null> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) return null;
  try {
    return await clipboard.readText();
  } catch {
    return null;
  }
}

export const BROWSER_TERMINAL_ENVIRONMENT: TerminalEnvironment = {
  createEngine: createXtermEngine,
  createSocket: browserTerminalSocketFactory,
  socketUrl: (hostId) => terminalSocketUrl(hostId),
  copyText,
  readClipboard,
  fontReady: (font) => terminalFontReady(font),
  loadFont: (font) => loadTerminalFont(font),
};

export const TerminalEnvironmentContext = createContext<TerminalEnvironment>(BROWSER_TERMINAL_ENVIRONMENT);

export function useTerminalEnvironment(): TerminalEnvironment {
  return useContext(TerminalEnvironmentContext);
}
