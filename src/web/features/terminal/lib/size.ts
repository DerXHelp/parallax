import { TERMINAL_LIMITS } from '@shared/terminal';

/** Columns and rows of a terminal. */
export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Size of `open` before any view measured the panel (the view sends its fitted size with `attach`). */
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** `size` within the limits of the protocol (whole numbers; anything not finite → the default). */
export function clampTerminalSize(size: TerminalSize): TerminalSize {
  return {
    cols: clamp(size.cols, TERMINAL_LIMITS.colsMin, TERMINAL_LIMITS.colsMax, DEFAULT_TERMINAL_SIZE.cols),
    rows: clamp(size.rows, TERMINAL_LIMITS.rowsMin, TERMINAL_LIMITS.rowsMax, DEFAULT_TERMINAL_SIZE.rows),
  };
}

export function sameSize(a: TerminalSize, b: TerminalSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}
