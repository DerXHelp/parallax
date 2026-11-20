import type { TerminalId } from '@shared/terminal';
import type { TerminalEngine } from '../lib/engine';
import { readTerminalFont } from '../lib/font';
import { createTerminalKeyHandler } from '../lib/keys';
import { DEFAULT_TERMINAL_SIZE, sameSize, type TerminalSize } from '../lib/size';
import { readTerminalTheme, watchTerminalTheme } from '../lib/theme';
import type { TerminalController } from './controller';
import type { TerminalEnvironment } from './environment';
import { getScreenReaderMode } from './terminals';

/** Resize bursts (dragging the splitter) end in one fit and one `resize`. */
export const RESIZE_DEBOUNCE_MS = 100;

export interface TerminalViewRuntimeOptions {
  host: HTMLElement;
  env: TerminalEnvironment;
  controller: TerminalController;
  terminalId: TerminalId;
  /** Keys and pastes (the view drops them once the terminal exited). */
  onInput(data: string): void;
}

/**
 * The engine of one terminal view (WP-99b), outside React: waits for the mono font (xterm measures
 * its cells once), opens the engine in the host, attaches to the terminal with the fitted size and
 * writes its output; fits again on host resizes (debounced) and zoom changes and sends `resize`;
 * follows the theme. Created when the view is active for the first time, disposed on unmount (the
 * controller then sends `detach`).
 */
export class TerminalViewRuntime {
  private engineValue: TerminalEngine | null = null;
  private size: TerminalSize = DEFAULT_TERMINAL_SIZE;
  private readonly cleanups: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private wantFocus = false;

  constructor(private readonly options: TerminalViewRuntimeOptions) {
    const font = readTerminalFont(options.host);
    if (options.env.fontReady(font)) {
      this.open();
    } else {
      void options.env.loadFont(font).then(() => {
        if (!this.disposed) this.open();
      });
    }
  }

  /** The engine once opened (null while the font loads and after dispose). */
  get engine(): TerminalEngine | null {
    return this.engineValue;
  }

  /** Focus now, or as soon as the engine is open. */
  focus(): void {
    if (this.engineValue === null) this.wantFocus = true;
    else this.engineValue.focus();
  }

  /** The zoom changed: new font size, then fit again. */
  updateFont(): void {
    if (this.engineValue === null) return;
    this.engineValue.setFont(readTerminalFont(this.options.host));
    this.scheduleFit();
  }

  setScreenReaderMode(enabled: boolean): void {
    this.engineValue?.setScreenReaderMode(enabled);
  }

  /** Copies the selection to the clipboard and clears it (Ctrl+C, menu "Copy"). */
  copySelection(): void {
    const engine = this.engineValue;
    if (!engine?.hasSelection()) return;
    const text = engine.getSelection();
    engine.clearSelection();
    void this.options.env.copyText(text);
  }

  /** Menu "Paste" (Clipboard API); false when the browser refused to read the clipboard. */
  async paste(): Promise<boolean> {
    const text = await this.options.env.readClipboard();
    if (text === null) return false;
    if (text !== '' && !this.disposed) this.engineValue?.paste(text);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    this.engineValue?.dispose();
    this.engineValue = null;
  }

  private open(): void {
    const { host, env, controller, terminalId } = this.options;
    const engine = env.createEngine({
      theme: readTerminalTheme(host.ownerDocument.documentElement),
      font: readTerminalFont(host),
      screenReaderMode: getScreenReaderMode(),
    });
    this.engineValue = engine;
    engine.open(host);
    engine.setKeyHandler(
      createTerminalKeyHandler({
        hasSelection: () => engine.hasSelection(),
        copySelection: () => {
          this.copySelection();
        },
      }),
    );
    this.cleanups.push(
      engine.onData((data) => {
        this.options.onInput(data);
      }),
    );
    this.size = engine.fit() ?? engine.size;
    controller.noteSize(this.size);
    this.cleanups.push(
      controller.attachView(terminalId, {
        size: () => this.size,
        onAttached: () => {
          engine.reset();
        },
        onOutput: (data) => {
          engine.write(data);
        },
      }),
      watchTerminalTheme((theme) => {
        engine.setTheme(theme);
      }, host.ownerDocument.documentElement),
    );
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        this.scheduleFit();
      });
      observer.observe(host);
      this.cleanups.push(() => {
        observer.disconnect();
      });
    }
    if (this.wantFocus) {
      this.wantFocus = false;
      engine.focus();
    }
  }

  private scheduleFit(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refit();
    }, RESIZE_DEBOUNCE_MS);
  }

  private refit(): void {
    const engine = this.engineValue;
    if (engine === null) return;
    const next = engine.fit();
    if (next === null || sameSize(next, this.size)) return;
    this.size = next;
    this.options.controller.resize(this.options.terminalId, next);
  }
}
