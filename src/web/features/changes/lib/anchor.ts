import { LIMITS } from '@shared/common';
import type { ReviewComment, ReviewSide } from '@shared/model';
import type { DiffRow } from '@web/lib/diff';
import { isLineRow } from './patch';

/**
 * Anchors of review comments in a file diff (ADR-254): a comment names its side (`old` = the version
 * before, `new` = the working tree), its line range and the quoted lines. When the diff moves, the
 * quote is searched again like `web/lib/text-anchor` does for plan passages – the occurrence closest
 * to the stored line wins (a review comment has no prefix/suffix context). Not found = stale. Pure.
 */

/** One line of one side of the diff (only the lines the patch shows: changes plus context). */
export interface SideLine {
  line: number;
  text: string;
  /** Index of its row in the diff rows. */
  row: number;
}

/** Where a comment stands in the current diff. */
export interface Placement {
  line: number;
  endLine: number;
}

/** A new comment's anchor (from a selection of rows or the keyboard cursor). */
export interface LineAnchor extends Placement {
  side: ReviewSide;
  quote: string;
}

function lineOf(row: DiffRow, side: ReviewSide): number | null {
  return side === 'new' ? row.newLine : row.oldLine;
}

/** The lines of `side` in diff order. */
export function sideLines(rows: readonly DiffRow[], side: ReviewSide): SideLine[] {
  const lines: SideLine[] = [];
  rows.forEach((row, index) => {
    const line = lineOf(row, side);
    if (line !== null) lines.push({ line, text: row.text, row: index });
  });
  return lines;
}

/** The text of the lines `line…endLine` of a side as the diff shows them (gaps between hunks skipped). */
function rangeText(lines: readonly SideLine[], line: number, endLine: number): string | null {
  const inRange = lines.filter((entry) => entry.line >= line && entry.line <= endLine);
  return inRange.length === 0 ? null : inRange.map((entry) => entry.text).join('\n');
}

/** Shortened to the contract's quote limit (the search of a cut quote still finds its beginning). */
export function clipQuote(quote: string): string {
  return quote.length > LIMITS.reviewQuoteChars ? quote.slice(0, LIMITS.reviewQuoteChars) : quote;
}

/**
 * The anchor of the rows `from…to` (either order): side `new` when any of them has a new line number
 * (added or context lines), else `old` (only removed lines). Null without a line row.
 */
export function anchorOfRows(rows: readonly DiffRow[], from: number, to: number): LineAnchor | null {
  const first = Math.max(0, Math.min(from, to));
  const last = Math.min(rows.length - 1, Math.max(from, to));
  const picked = rows.slice(first, last + 1).filter(isLineRow);
  const side: ReviewSide = picked.some((row) => row.newLine !== null) ? 'new' : 'old';
  const onSide = picked.filter((row) => lineOf(row, side) !== null);
  const head = onSide[0];
  const tail = onSide.at(-1);
  if (head === undefined || tail === undefined) return null;
  return {
    side,
    line: lineOf(head, side) ?? 0,
    endLine: lineOf(tail, side) ?? 0,
    quote: clipQuote(onSide.map((row) => row.text).join('\n')),
  };
}

/**
 * Where the comment stands now: its stored range when the quote is still there, else the occurrence
 * of the quote closest to the stored line (the range covers every line the quote touches); null =
 * not found (stale). A comment without a quote stays while its last line is in the diff.
 */
export function placeComment(
  lines: readonly SideLine[],
  anchor: Pick<ReviewComment, 'line' | 'endLine' | 'quote'>,
): Placement | null {
  const { quote } = anchor;
  if (quote === '') {
    return lines.some((entry) => entry.line === anchor.endLine)
      ? { line: anchor.line, endLine: anchor.endLine }
      : null;
  }
  if (rangeText(lines, anchor.line, anchor.endLine)?.includes(quote) === true) {
    return { line: anchor.line, endLine: anchor.endLine };
  }
  const text = lines.map((entry) => entry.text).join('\n');
  // Start offset of every line in `text` (ascending) – maps a found offset back to its line.
  const starts: number[] = [];
  let offset = 0;
  for (const entry of lines) {
    starts.push(offset);
    offset += entry.text.length + 1;
  }
  const indexAt = (at: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  let best: Placement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const first = lines[indexAt(at)];
    const last = lines[indexAt(at + quote.length - 1)];
    if (first === undefined || last === undefined) continue;
    const distance = Math.abs(first.line - anchor.line);
    if (distance < bestDistance) {
      best = { line: first.line, endLine: last.line };
      bestDistance = distance;
    }
  }
  return best;
}

/** `side:line` → row index, for the row a comment is shown under (its last line). */
export function rowIndexBySideLine(rows: readonly DiffRow[]): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.newLine !== null) map.set(`new:${String(row.newLine)}`, index);
    if (row.oldLine !== null) map.set(`old:${String(row.oldLine)}`, index);
  });
  return map;
}

/** The comments of one file placed in its diff. */
export interface PlacedComments {
  /** Comment id → where it stands now; null = not found (stale). */
  placements: ReadonlyMap<ReviewComment['id'], Placement | null>;
  /** Row index → the comments shown below that row (their last line), in the given order. */
  byRow: ReadonlyMap<number, readonly ReviewComment[]>;
  /** Comments without a row in this diff. */
  unplaced: readonly ReviewComment[];
}

export function placeComments(rows: readonly DiffRow[], comments: readonly ReviewComment[]): PlacedComments {
  const placements = new Map<ReviewComment['id'], Placement | null>();
  const byRow = new Map<number, ReviewComment[]>();
  const unplaced: ReviewComment[] = [];
  const rowOf = rowIndexBySideLine(rows);
  const sides: Partial<Record<ReviewSide, SideLine[]>> = {};
  for (const comment of comments) {
    const lines = (sides[comment.side] ??= sideLines(rows, comment.side));
    const placement = placeComment(lines, comment);
    placements.set(comment.id, placement);
    const row = placement === null ? undefined : rowOf.get(`${comment.side}:${String(placement.endLine)}`);
    if (row === undefined) unplaced.push(comment);
    else byRow.set(row, [...(byRow.get(row) ?? []), comment]);
  }
  return { placements, byRow, unplaced };
}

/**
 * What the window shows for a comment: with an `authoritative` diff (the complete session diff) a
 * comment not found is stale and a stale one found again is open; otherwise its stored state.
 */
export function shownState(
  comment: ReviewComment,
  placement: Placement | null | undefined,
  authoritative: boolean,
): ReviewComment['state'] {
  if (!authoritative || placement === undefined) return comment.state;
  if (placement === null) return 'stale';
  return comment.state === 'stale' ? 'open' : comment.state;
}

/**
 * The `review.update` that brings the stored comment in line with the diff (moved range, stale, or
 * found again); null = nothing to change. Only for an authoritative diff.
 */
export function anchorUpdate(
  comment: ReviewComment,
  placement: Placement | null,
): { line?: number; endLine?: number; state?: 'open' | 'stale' } | null {
  if (placement === null) return comment.state === 'stale' ? null : { state: 'stale' };
  const moved = placement.line !== comment.line || placement.endLine !== comment.endLine;
  const revived = comment.state === 'stale';
  if (!moved && !revived) return null;
  return {
    ...(moved ? { line: placement.line, endLine: placement.endLine } : {}),
    ...(revived ? { state: 'open' as const } : {}),
  };
}
