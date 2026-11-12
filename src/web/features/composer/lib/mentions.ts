import type { ErrorPayload } from '@shared/errors';
import { fuzzyFilter } from '@web/lib/fuzzy';

/**
 * @ file picker (ADR-151, WP-57): pure helpers. `@` at the start of a word – not in an e-mail
 * address, not in a code span or fence – opens a list of the project files (`files.project`,
 * relative paths with `/`); the pick inserts `@<path> ` (with whitespace in the path
 * `@"<path>" `), which the CLI expands like in the terminal (L8).
 */

/** At most this many matches are shown. */
export const MENTION_MATCHES_MAX = 50;

/** DOM id of the @ list of a composer (the field's `aria-controls`; the list is a lazy chunk). */
export function mentionMenuId(inputId: string): string {
  return `${inputId}-mention`;
}

/** The project files of one opening of the picker. */
export type ProjectFilesState =
  | { status: 'loading' }
  | { status: 'ready'; index: PathIndex; truncated: boolean }
  | { status: 'error'; error: ErrorPayload };

/** An `@` word under the caret: `[start, end)` is replaced by a pick, `query` filters. */
export interface Mention {
  /** Index of the `@`. */
  start: number;
  /** End of the word (the caret may stand inside it). */
  end: number;
  /** Typed after the `@` up to the caret (without a leading/closing quote). */
  query: string;
}

/** Characters after which an `@` starts a word (besides the text start). */
const WORD_BEFORE = /[\s([{]/;
const FENCE = /^\s*(```|~~~)/;

/** True when `index` stands in a fenced code block or in an inline code span of its line. */
export function insideCode(text: string, index: number): boolean {
  let fence = false;
  let lineStart = 0;
  for (;;) {
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const line = text.slice(lineStart, end);
    const isFence = FENCE.test(line);
    if (index <= end) {
      if (fence || isFence) return true;
      const ticks = line.slice(0, index - lineStart).split('`').length - 1;
      return ticks % 2 === 1;
    }
    if (isFence) fence = !fence;
    if (lineEnd < 0) return false;
    lineStart = lineEnd + 1;
  }
}

/** The `@` word the caret stands in (typed part without whitespace), else null. */
export function mentionAt(text: string, caret: number): Mention | null {
  if (caret < 1 || caret > text.length) return null;
  const head = text.slice(0, caret);
  const at = head.lastIndexOf('@');
  if (at < 0) return null;
  const typed = head.slice(at + 1);
  if (/\s/.test(typed)) return null;
  if (at > 0 && !WORD_BEFORE.test(text.charAt(at - 1))) return null;
  if (insideCode(text, at)) return null;
  const tail = /^\S*/.exec(text.slice(caret))?.[0] ?? '';
  return { start: at, end: caret + tail.length, query: typed.replace(/^"|"$/g, '') };
}

/** `@path`, or `@"path"` when the path contains whitespace. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The draft after picking `path` for `mention`: one space after it, the caret behind that space. */
export function applyMention(text: string, mention: Mention, path: string): { text: string; caret: number } {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const inserted = mentionText(path);
  const space = /^\s/.test(after) ? '' : ' ';
  return { text: `${before}${inserted}${space}${after}`, caret: before.length + inserted.length + 1 };
}

/** Lower case without diacritics (how `lib/fuzzy` compares). */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Project paths with their folded form (built once per list – the cheap pre-filter uses it). */
export interface PathIndex {
  paths: readonly string[];
  folded: readonly string[];
}

export function indexPaths(paths: readonly string[]): PathIndex {
  return { paths, folded: paths.map(fold) };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = haystack.indexOf(char, at);
    if (at < 0) return false;
    at += char.length;
  }
  return true;
}

/** Last segment of a relative path (also of its folded form – folding keeps the `/`). */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Rank groups of a match (V4-03), best first: every token as typed in the file name, fuzzy in the
 * file name, every token as typed somewhere in the path, any other (strict) match.
 */
const GROUP = { nameContains: 0, nameFuzzy: 1, pathContains: 2, pathFuzzy: 3 } as const;

/**
 * The best `max` paths for `query` and how many matched; an empty query keeps the list order.
 * - A subsequence check on the folded paths first keeps a list of 20 000 paths fast while typing.
 * - Minimum quality (V4-03): `fuzzyFilter` in strict mode over the file name and the whole path
 *   (each whitespace-separated token may hit either) – word starts and runs must pay for the gaps,
 *   so `secret` no longer hits `verschachtelt/noch-tiefer/…/mit-…` letter by letter.
 * - File-name hits rank before path hits, contiguous ones before fuzzy ones (`GROUP`); the fuzzy
 *   score orders each group.
 */
export function matchPaths(
  index: PathIndex,
  query: string,
  max: number = MENTION_MATCHES_MAX,
): { matches: string[]; total: number } {
  const tokens = fold(query)
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return { matches: index.paths.slice(0, max), total: index.paths.length };
  const needle = tokens.join('');
  const candidates: number[] = [];
  index.folded.forEach((folded, i) => {
    if (isSubsequence(needle, folded)) candidates.push(i);
  });
  const pathAt = (i: number): string => index.paths[i] ?? '';
  const scored = fuzzyFilter(candidates, query, (i) => [nameOf(pathAt(i)), pathAt(i)], { strict: true });
  const fuzzyInName = new Set(fuzzyFilter(scored, query, (i) => [nameOf(pathAt(i))], { strict: true }));
  const groupOf = (i: number): number => {
    const folded = index.folded[i] ?? '';
    const name = nameOf(folded);
    if (tokens.every((token) => name.includes(token))) return GROUP.nameContains;
    if (fuzzyInName.has(i)) return GROUP.nameFuzzy;
    if (tokens.every((token) => folded.includes(token))) return GROUP.pathContains;
    return GROUP.pathFuzzy;
  };
  const ranked = scored
    .map((i, order) => ({ i, order, group: groupOf(i) }))
    .sort((a, b) => a.group - b.group || a.order - b.order);
  return { matches: ranked.slice(0, max).map((entry) => pathAt(entry.i)), total: ranked.length };
}

/** Last segment and the folder part of a relative path (`src/a/b.ts` → `b.ts`, `src/a`). */
export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { name: path, folder: '' }
    : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}
