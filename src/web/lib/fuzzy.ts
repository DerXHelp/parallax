/**
 * Fuzzy matching for pickers (quick switcher WP-35, slash menu WP-37, recent projects WP-36): the
 * query characters must appear in order (case- and accent-insensitive); matches at word starts and
 * consecutive runs score higher, so "fb" ranks "foo bar" above "afbx". Pure, no dependencies.
 */

/** Score of one matched character. */
const MATCH = 1;
/** The previous query character matched the directly preceding text character. */
const CONSECUTIVE = 8;
/** Per skipped text character between two matches ("abc" beats "a_b_c"). */
const GAP = 1.5;
/** The character starts a word (after a separator, a camelCase hump, or at index 0). */
const WORD_START = 8;
/** Extra for a match at the very first text character. */
const PREFIX = 3;
/** Per text character: shorter texts win ties. */
const LENGTH_PENALTY = 0.01;

const SEPARATOR = /[\s\-_/\\.:,;()[\]{}#@+]/;

/** Characters without diacritics ("Über" → U, b, e, r), one entry per code point. */
function characters(value: string): string[] {
  // Code points are enough here (emoji sequences only need to match themselves).
  return Array.from(value.normalize('NFD').replace(/\p{M}/gu, ''));
}

function isWordStart(chars: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const previous = chars[index - 1] ?? '';
  if (SEPARATOR.test(previous)) return true;
  const current = chars[index] ?? '';
  // camelCase / PascalCase hump: "parseSession" → "S".
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

/**
 * Score of `query` in `text`, or null if the query characters do not all appear in order.
 * Whitespace in the query is ignored; an empty query matches everything with score 0.
 * Higher is better (scores are only comparable for the same query).
 */
export function fuzzyScore(query: string, text: string): number | null {
  return scoreDetail(query, text)?.score ?? null;
}

interface ScoreDetail {
  /** Final score (`raw` minus the length penalty of the text). */
  score: number;
  /** Matches, word starts and runs minus the gaps – before the length penalty. */
  raw: number;
  /** Query characters without whitespace. */
  length: number;
}

function scoreDetail(query: string, text: string): ScoreDetail | null {
  const needle = characters(query)
    .filter((char) => !/\s/.test(char))
    .map((char) => char.toLowerCase());
  if (needle.length === 0) return { score: 0, raw: 0, length: 0 };
  const chars = characters(text);
  const haystack = chars.map((char) => char.toLowerCase());
  const n = needle.length;
  const m = haystack.length;
  if (n > m) return null;
  const bonus = haystack.map(
    (_, j) => MATCH + (isWordStart(chars, j) ? WORD_START : 0) + (j === 0 ? PREFIX : 0),
  );

  // previous[j]: best score with the last handled query character matched at text index j.
  let previous: (number | null)[] = haystack.map((char, j) => (char === needle[0] ? (bonus[j] ?? 0) : null));
  for (let i = 1; i < n; i++) {
    const current: (number | null)[] = Array.from({ length: m }, () => null);
    // Best score of the previous row at k <= j - 2, minus GAP per skipped character (j - 1 - k).
    let bestBefore: number | null = null;
    for (let j = 1; j < m; j++) {
      if (bestBefore !== null) bestBefore -= GAP;
      const beforeGap = previous[j - 2];
      if (j >= 2 && beforeGap !== null && beforeGap !== undefined) {
        bestBefore = bestBefore === null ? beforeGap - GAP : Math.max(bestBefore, beforeGap - GAP);
      }
      if (haystack[j] !== needle[i]) continue;
      const adjacent = previous[j - 1];
      const viaRun = adjacent === null || adjacent === undefined ? null : adjacent + CONSECUTIVE;
      const best = viaRun === null ? bestBefore : bestBefore === null ? viaRun : Math.max(viaRun, bestBefore);
      if (best !== null) current[j] = best + (bonus[j] ?? 0);
    }
    previous = current;
  }
  let result: number | null = null;
  for (const value of previous) {
    if (value !== null && (result === null || value > result)) result = value;
  }
  return result === null ? null : { score: result - m * LENGTH_PENALTY, raw: result, length: n };
}

export interface FuzzyFilterOptions {
  /**
   * Drops scattered matches (V3-03): a token counts only if word starts and runs pay for its gaps
   * (at least one point per character) – "fake" then no longer hits "fuer-den-lauf-der-kopfzeile",
   * "lpc" still hits "Landing page copy".
   */
  strict?: boolean;
  /** Each later key costs this many points, so earlier keys win near ties (e.g. title before profile). */
  keyPenalty?: number;
}

/**
 * Items whose `keys` match every whitespace-separated token of `query` (each token may match a
 * different key), best first; equal scores keep the input order. An empty query returns all items
 * in their order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keys: (item: T) => string[],
  options: FuzzyFilterOptions = {},
): T[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return [...items];
  const strict = options.strict === true;
  const keyPenalty = options.keyPenalty ?? 0;
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const texts = keys(item);
    let total = 0;
    for (const token of tokens) {
      let best: number | null = null;
      for (const [keyIndex, text] of texts.entries()) {
        const detail = scoreDetail(token, text);
        if (detail === null || (strict && detail.raw < detail.length * MATCH)) continue;
        const score = detail.score - keyIndex * keyPenalty;
        if (best === null || score > best) best = score;
      }
      if (best === null) return;
      total += best;
    }
    scored.push({ item, score: total, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}
