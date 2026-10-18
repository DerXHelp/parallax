import { closesFence, openingFence, type Fence } from './markdown-blocks';

/**
 * V2-12: CommonMark turns `\.` `\_` `\*` … into the bare punctuation, so `C:\Users\user\.claude`
 * in running text showed as `C:\Users\user.claude`. Before parsing, every backslash of a Windows
 * path (`X:\…` up to the next whitespace) that stands before an ASCII punctuation character (or
 * ends the line – a hard break) is doubled, so the renderer shows it as typed. Everything else
 * stays untouched: code spans, fenced code, indented lines (possible code blocks) and escapes
 * outside paths (`\*not bold\*`).
 */

/** A drive path: letter + `:\` not inside a word (`file:\x` is none), up to whitespace. */
const DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:\\\S*/g;
/** A backslash before ASCII punctuation (CommonMark escapable) or at the end of the path. */
const ESCAPING_BACKSLASH = /\\(?=[!-/:-@[-`{-~]|$)/g;
/** Indented code blocks (4 spaces or a tab) keep their backslashes literally anyway. */
const INDENTED = /^(?: {4}|\t)/;

function protectText(text: string): string {
  return text.replace(DRIVE_PATH, (path) => path.replace(ESCAPING_BACKSLASH, '\\\\'));
}

/** Is the character at `index` escaped by an odd number of backslashes before it? */
function escaped(line: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && line[i] === '\\'; i--) count++;
  return count % 2 === 1;
}

function backtickRun(line: string, start: number): number {
  let end = start;
  while (line[end] === '`') end++;
  return end - start;
}

/** Start of the closing backtick run of exactly `length` after `from`, else -1. */
function closingRun(line: string, from: number, length: number): number {
  let index = line.indexOf('`', from);
  while (index >= 0) {
    const run = backtickRun(line, index);
    if (run === length) return index;
    index = line.indexOf('`', index + run);
  }
  return -1;
}

/** One line outside fenced code: paths in the text parts, code spans unchanged. */
function protectLine(line: string): string {
  if (!line.includes(':\\')) return line;
  let out = '';
  let position = 0;
  let search = 0;
  while (search < line.length) {
    const tick = line.indexOf('`', search);
    if (tick < 0) break;
    const length = backtickRun(line, tick);
    if (escaped(line, tick)) {
      search = tick + length;
      continue;
    }
    const close = closingRun(line, tick + length, length);
    if (close < 0) {
      search = tick + length;
      continue;
    }
    out += protectText(line.slice(position, tick)) + line.slice(tick, close + length);
    position = close + length;
    search = position;
  }
  return out + protectText(line.slice(position));
}

export function preserveWindowsPaths(markdown: string): string {
  if (!markdown.includes(':\\')) return markdown;
  const lines = markdown.split('\n');
  let fence: Fence | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = openingFence(line);
    if (fence !== null || INDENTED.test(line)) continue;
    lines[index] = protectLine(line);
  }
  return lines.join('\n');
}
