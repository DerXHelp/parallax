/**
 * Splits Markdown into top-level blocks for memoized rendering (B "fertige Blöcke werden gecacht,
 * nur das Ende wird neu geparst", C.14): while a text streams, only its last block changes, so
 * every earlier block keeps its props and is not parsed again.
 *
 * Rules (stable under appending: a split or join only ever changes the LAST block):
 * - a blank line outside a code fence ends a block,
 * - except when the next line continues it: indented lines (list continuation, nested content)
 *   and a list item after a list (loose lists stay one list),
 * - fenced code (``` or ~~~, CommonMark lengths) is never split; an unclosed fence at the end marks
 *   the block `openFence` (still streaming – no syntax highlighting yet).
 * Known limits: reference-style links/footnotes defined in another block stay unresolved.
 */

export interface MarkdownBlock {
  text: string;
  /** The block ends inside an unclosed code fence. */
  openFence: boolean;
}

interface Fence {
  char: '`' | '~';
  length: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const BLANK = /^\s*$/;

function openingFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return null;
  const char = marker.startsWith('~') ? '~' : '`';
  // A backtick fence's info string must not contain backticks (CommonMark).
  if (char === '`' && (match?.[2] ?? '').includes('`')) return null;
  return { char, length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length || line.length - line.trimStart().length > 3) return false;
  for (const ch of trimmed) if (ch !== fence.char) return false;
  return true;
}

export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let current: string[] = [];
  let fence: Fence | null = null;
  let blankPending = 0;

  const push = () => {
    if (current.length > 0) blocks.push({ text: current.join('\n'), openFence: false });
    current = [];
  };

  const lastIndex = lines.length - 1;
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      current.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (BLANK.test(line)) {
      if (current.length > 0) blankPending++;
      continue;
    }
    if (blankPending > 0) {
      // A still incomplete last line (streaming) stays with the current block until it is
      // complete: "2" may still become "2. item" – deciding now would change an earlier block.
      const incomplete = index === lastIndex;
      const continues =
        incomplete || /^\s/.test(line) || (LIST_ITEM.test(current[0] ?? '') && LIST_ITEM.test(line));
      if (continues) for (let i = 0; i < blankPending; i++) current.push('');
      else push();
      blankPending = 0;
    }
    current.push(line);
    fence = openingFence(line);
  }
  if (current.length > 0) blocks.push({ text: current.join('\n'), openFence: fence !== null });
  return blocks;
}
