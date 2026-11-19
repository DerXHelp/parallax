import { closesFence, openingFence, splitMarkdownBlocks, type Fence } from './markdown-blocks';
import { plainInline } from './plain-text';

/**
 * WP-93 (ADR-234): the blocks of a plan text as the plan tab renders and annotates them. The
 * Markdown blocks of `splitMarkdownBlocks`, with a list split into its top-level items (an
 * annotation then sits right below the item, not below the whole list; an ordered item keeps its
 * number, Markdown renders it as `<ol start>`). Each block knows its lines in the plan text and the
 * headings above it (the feedback names them). Pure.
 */

export interface PlanBlock {
  /** Markdown of the block. */
  text: string;
  /** A heading line, a top-level list item, or anything else (spacing in the plan tab). */
  kind: 'heading' | 'item' | 'text';
  /** 1-based first and last line in the plan text (trailing blank lines not counted). */
  startLine: number;
  endLine: number;
  /** Headings (ATX, outermost first) the block belongs to – a heading block includes itself. */
  path: readonly string[];
}

const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const LIST_ITEM = /^( {0,3})(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** A list item that may interrupt a paragraph (CommonMark: a bullet or `1.`, not empty). */
const INTERRUPTING_ITEM = /^ {0,3}(?:[-*+]|1[.)])\s+\S/;
const BLANK = /^\s*$/;

/** Level and text of an ATX heading line, else null. */
export function headingOf(line: string): { level: number; text: string } | null {
  const match = HEADING.exec(line);
  const marks = match?.[1];
  if (marks === undefined) return null;
  return { level: marks.length, text: plainInline(match?.[2] ?? '') };
}

interface Part {
  /** Index of the first line within the enclosing lines. */
  offset: number;
  lines: string[];
}

/**
 * A Markdown block cut where a new block starts without a blank line: before and after every
 * heading at the line start (`## Plan` right above its list), and where a bullet or `1.` list
 * interrupts a paragraph (CommonMark renders both the same way either way). Fences are never cut.
 */
function splitSegments(lines: readonly string[]): Part[] {
  const parts: Part[] = [];
  let current: Part = { offset: 0, lines: [] };
  let fence: Fence | null = null;
  let inList = false;
  const cut = (index: number) => {
    if (current.lines.length > 0) parts.push(current);
    current = { offset: index, lines: [] };
  };
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      current.lines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (line.startsWith('#') && headingOf(line) !== null) {
      cut(index);
      current.lines.push(line);
      cut(index + 1);
      continue;
    }
    if (current.lines.length === 0) inList = LIST_ITEM.test(line);
    else if (!inList && INTERRUPTING_ITEM.test(line)) {
      cut(index);
      inList = true;
    }
    current.lines.push(line);
    fence = openingFence(line);
  }
  cut(lines.length);
  return parts;
}

/** A list split at its top-level items (code fences never split); other lines unchanged. */
function splitListItems(lines: readonly string[]): Part[] {
  const indent = LIST_ITEM.exec(lines[0] ?? '')?.[1];
  if (indent === undefined) return [{ offset: 0, lines: [...lines] }];
  const parts: Part[] = [];
  let current: Part = { offset: 0, lines: [] };
  let fence: Fence | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      current.lines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (index > 0 && LIST_ITEM.exec(line)?.[1] === indent) {
      parts.push(current);
      current = { offset: index, lines: [] };
    }
    current.lines.push(line);
    fence = openingFence(line);
  }
  parts.push(current);
  return parts;
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && BLANK.test(lines[end - 1] ?? '')) end -= 1;
  return lines.slice(0, end);
}

export function splitPlanBlocks(plan: string): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const headings: { level: number; text: string }[] = [];
  const enter = (heading: { level: number; text: string }) => {
    while ((headings.at(-1)?.level ?? 0) >= heading.level) headings.pop();
    headings.push(heading);
  };
  // A complete text: its last line is final (the splitter keeps an unfinished last line of a
  // streaming text with the block before it).
  for (const block of splitMarkdownBlocks(plan.endsWith('\n') ? plan : `${plan}\n`)) {
    for (const segment of splitSegments(block.text.split('\n'))) {
      for (const part of splitListItems(segment.lines)) {
        const own = trimTrailingBlank(part.lines);
        if (own.length === 0) continue;
        const first = headingOf(own[0] ?? '');
        if (first !== null) enter(first);
        const startLine = block.startLine + segment.offset + part.offset + 1;
        blocks.push({
          text: own.join('\n'),
          kind: first !== null ? 'heading' : LIST_ITEM.test(own[0] ?? '') ? 'item' : 'text',
          startLine,
          endLine: startLine + own.length - 1,
          path: headings.map((heading) => heading.text).filter((text) => text !== ''),
        });
      }
    }
  }
  return blocks;
}
