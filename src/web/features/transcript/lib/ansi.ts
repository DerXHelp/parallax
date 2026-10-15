/**
 * Safe ANSI parsing for terminal output (Review C.10 "ANSI wird escaped"): a small scanner (no
 * regex over control characters) turns SGR sequences into style segments; every other escape
 * sequence (cursor movement, OSC hyperlinks/titles, …) and stray C0 controls are dropped. The
 * result is plain text plus styles – rendered as React text nodes, never as HTML.
 */

export const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
export type AnsiColor = (typeof ANSI_COLORS)[number];

export interface AnsiStyle {
  readonly fg: AnsiColor | null;
  readonly bg: AnsiColor | null;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

export const PLAIN_STYLE: AnsiStyle = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
});

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const TAB = 0x09;
const DEL = 0x7f;

function color(index: number): AnsiColor | null {
  return ANSI_COLORS[index % 8] ?? null;
}

/** 256-color index → one of the 16 base colors (others are ignored: no raw colors in the UI). */
function extendedColor(params: readonly number[], at: number): { color: AnsiColor | null; used: number } {
  const mode = params[at + 1];
  if (mode === 5) {
    const index = params[at + 2];
    return { color: index !== undefined && index >= 0 && index < 16 ? color(index) : null, used: 2 };
  }
  if (mode === 2) return { color: null, used: 4 };
  return { color: null, used: 0 };
}

/** Applies one SGR parameter list (`1;31`, `0`, `38;5;9` …) to a style (immutable). */
export function applySgr(style: AnsiStyle, raw: string): AnsiStyle {
  const params = raw === '' ? [0] : raw.split(/[;:]/).map((part) => (part === '' ? 0 : Number(part)));
  let next: AnsiStyle = style;
  const set = (patch: Partial<AnsiStyle>) => {
    next = { ...next, ...patch };
  };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === undefined || !Number.isFinite(code)) continue;
    if (code === 0) next = PLAIN_STYLE;
    else if (code === 1) set({ bold: true });
    else if (code === 2) set({ dim: true });
    else if (code === 3) set({ italic: true });
    else if (code === 4) set({ underline: true });
    else if (code === 22) set({ bold: false, dim: false });
    else if (code === 23) set({ italic: false });
    else if (code === 24) set({ underline: false });
    else if (code >= 30 && code <= 37) set({ fg: color(code - 30) });
    else if (code >= 90 && code <= 97) set({ fg: color(code - 90) });
    else if (code === 39) set({ fg: null });
    else if (code >= 40 && code <= 47) set({ bg: color(code - 40) });
    else if (code >= 100 && code <= 107) set({ bg: color(code - 100) });
    else if (code === 49) set({ bg: null });
    else if (code === 38 || code === 48) {
      const extended = extendedColor(params, i);
      set(code === 38 ? { fg: extended.color } : { bg: extended.color });
      i += extended.used;
    }
  }
  return isPlain(next) ? PLAIN_STYLE : next;
}

function isPlain(style: AnsiStyle): boolean {
  return (
    style.fg === null && style.bg === null && !style.bold && !style.dim && !style.italic && !style.underline
  );
}

/** Index after an escape sequence starting at `start` (ESC). */
function skipEscape(input: string, start: number): { end: number; sgr: string | null } {
  const kind = input[start + 1];
  if (kind === '[') {
    // CSI: parameter/intermediate bytes, then one final byte 0x40–0x7e.
    let j = start + 2;
    while (j < input.length) {
      const c = input.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) break;
      j++;
    }
    if (j >= input.length) return { end: input.length, sgr: null };
    return { end: j + 1, sgr: input[j] === 'm' ? input.slice(start + 2, j) : null };
  }
  if (kind === ']') {
    // OSC (titles, hyperlinks): until BEL or ESC \ – the payload is never shown.
    let j = start + 2;
    while (j < input.length) {
      const c = input.charCodeAt(j);
      if (c === BEL) return { end: j + 1, sgr: null };
      if (c === ESC && input[j + 1] === '\\') return { end: j + 2, sgr: null };
      j++;
    }
    return { end: input.length, sgr: null };
  }
  return { end: Math.min(input.length, start + 2), sgr: null };
}

/** Splits terminal text into styled segments; adjacent segments with the same style are merged. */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style = PLAIN_STYLE;
  let pending: string[] = [];
  let runStart = 0;

  const flushRun = (end: number) => {
    if (end > runStart) pending.push(input.slice(runStart, end));
  };
  const flushSegment = () => {
    if (pending.length === 0) return;
    const text = pending.join('');
    pending = [];
    const last = segments.at(-1);
    if (last?.style === style) last.text += text;
    else segments.push({ text, style });
  };

  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code === ESC) {
      flushRun(i);
      const { end, sgr } = skipEscape(input, i);
      if (sgr !== null) {
        flushSegment();
        style = applySgr(style, sgr);
      }
      i = end;
      runStart = i;
      continue;
    }
    if ((code < 0x20 && code !== LF && code !== TAB) || code === DEL) {
      flushRun(i);
      i++;
      runStart = i;
      continue;
    }
    i++;
  }
  flushRun(input.length);
  flushSegment();
  return segments;
}

/** Plain text without any escape sequence (copy, search, summaries). */
export function stripAnsi(input: string): string {
  return parseAnsi(input)
    .map((segment) => segment.text)
    .join('');
}
