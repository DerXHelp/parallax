import type { TerminalFont } from './engine';

/**
 * Font of the terminal (WP-99b): the computed `font-family` and `font-size` of the xterm host, which
 * carries the classes of the app's mono font (`font-mono text-xs`). The UI is in rem and the zoom is
 * the root font size (state/zoom.ts), so the computed size follows the zoom – read it again when the
 * zoom changes.
 */

const FALLBACK_FONT: TerminalFont = { family: 'Consolas, monospace', size: 13 };

export function readTerminalFont(element: Element): TerminalFont {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const family = style?.fontFamily.trim() ?? '';
  const size = Number.parseFloat(style?.fontSize ?? '');
  return {
    family: family === '' ? FALLBACK_FONT.family : family,
    size: Number.isFinite(size) && size > 0 ? size : FALLBACK_FONT.size,
  };
}

/** CSS font shorthand for the FontFaceSet API. */
function fontShorthand(font: TerminalFont): string {
  return `${String(font.size)}px ${font.family}`;
}

/** At most this long the view waits for the mono font before xterm measures its cells anyway. */
export const FONT_WAIT_MS = 1500;

/**
 * True when the font can be used at once. xterm measures its cell size when it opens and never again
 * for a font that arrives later, so the view waits for the font face first (`loadTerminalFont`).
 */
export function terminalFontReady(font: TerminalFont, doc: Document = document): boolean {
  const fonts = doc.fonts as FontFaceSet | undefined;
  if (fonts === undefined || typeof fonts.check !== 'function') return true;
  try {
    return fonts.check(fontShorthand(font));
  } catch {
    return true;
  }
}

/** Loads the font face (resolves after at most FONT_WAIT_MS, never rejects). */
export async function loadTerminalFont(font: TerminalFont, doc: Document = document): Promise<void> {
  const fonts = doc.fonts as FontFaceSet | undefined;
  if (fonts === undefined || typeof fonts.load !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(fontShorthand(font)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FONT_WAIT_MS);
      }),
    ]);
  } catch {
    // An unknown family or a failed download: xterm falls back to the next family of the list.
  } finally {
    clearTimeout(timer);
  }
}
