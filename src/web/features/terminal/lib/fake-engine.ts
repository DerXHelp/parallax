import type { ITheme } from '@xterm/xterm';
import type {
  EngineFactory,
  EngineOptions,
  TerminalEngine,
  TerminalFont,
  TerminalKeyHandler,
} from './engine';
import type { TerminalSize } from './size';

/**
 * Stand-in for the xterm engine in tests and the playground (happy-dom cannot lay out xterm): keeps
 * what the view wrote and set, and renders xterm's helper text area (`.xterm-helper-textarea`), so
 * focus, keys and the selectors of the shell (Alt+T) work. Its key listener runs the custom key
 * handler like xterm and records keys xterm would send – but never stops the event, so tests see what
 * reaches the window.
 */
export class FakeEngine implements TerminalEngine {
  host: HTMLElement | null = null;
  textarea: HTMLTextAreaElement | null = null;
  /** Output written so far, decoded as UTF-8 (stream). */
  output = '';
  resets = 0;
  clears = 0;
  disposed = false;
  focusCount = 0;
  selection = '';
  readonly pasted: string[] = [];
  /** Keys that reached "xterm" (the key handler returned true). */
  readonly keys: string[] = [];
  /** What `fit()` returns next (null = hidden host). */
  nextFit: TerminalSize | null = { cols: 100, rows: 30 };
  theme: ITheme;
  font: TerminalFont;
  screenReaderMode: boolean;
  conpty: boolean;
  keyHandler: TerminalKeyHandler | null = null;
  private current: TerminalSize = { cols: 80, rows: 24 };
  private readonly decoder = new TextDecoder();
  private readonly listeners = new Set<(data: string) => void>();

  constructor(options: EngineOptions) {
    this.theme = options.theme;
    this.font = options.font;
    this.screenReaderMode = options.screenReaderMode;
    this.conpty = options.conpty;
  }

  open(host: HTMLElement): void {
    if (this.host !== null) return;
    this.host = host;
    const textarea = host.ownerDocument.createElement('textarea');
    textarea.className = 'xterm-helper-textarea';
    textarea.addEventListener('keydown', (event) => {
      if (this.keyHandler !== null && !this.keyHandler(event)) return;
      this.keys.push(event.key);
    });
    host.append(textarea);
    this.textarea = textarea;
  }

  write(data: Uint8Array | string): void {
    this.output += typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
  }

  reset(): void {
    this.resets++;
    this.output = '';
  }

  clear(): void {
    this.clears++;
  }

  onData(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Simulates typed input (what xterm reports through `onData`). */
  type(data: string): void {
    for (const listener of [...this.listeners]) listener(data);
  }

  fit(): TerminalSize | null {
    if (this.host === null || this.nextFit === null) return null;
    this.current = { ...this.nextFit };
    return { ...this.current };
  }

  get size(): TerminalSize {
    return { ...this.current };
  }

  focus(): void {
    this.focusCount++;
    this.textarea?.focus();
  }

  hasSelection(): boolean {
    return this.selection !== '';
  }

  getSelection(): string {
    return this.selection;
  }

  clearSelection(): void {
    this.selection = '';
  }

  selectAll(): void {
    this.selection = this.output;
  }

  paste(text: string): void {
    this.pasted.push(text);
    this.type(text);
  }

  setTheme(theme: ITheme): void {
    this.theme = theme;
  }

  setFont(font: TerminalFont): void {
    this.font = font;
  }

  setScreenReaderMode(enabled: boolean): void {
    this.screenReaderMode = enabled;
  }

  setKeyHandler(handler: TerminalKeyHandler): void {
    this.keyHandler = handler;
  }

  dispose(): void {
    this.disposed = true;
    this.textarea?.remove();
    this.listeners.clear();
  }
}

/** A factory that creates `FakeEngine`s and keeps every one it created (oldest first). */
export function createFakeEngineFactory(): { factory: EngineFactory; engines: FakeEngine[] } {
  const engines: FakeEngine[] = [];
  return {
    engines,
    factory: (options) => {
      const engine = new FakeEngine(options);
      engines.push(engine);
      return engine;
    },
  };
}
