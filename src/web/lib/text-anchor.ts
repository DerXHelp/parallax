/**
 * WP-93 (ADR-234): text-quote anchors – a passage of a text as the quote plus a little text before
 * and after it, so the same words further down are not mistaken for it – and the DOM side: text
 * offsets of a selection inside an element and a `Range` back from offsets. Offsets count the
 * characters of the element's text nodes in document order (= `textContent`, = `Range.toString()`).
 */

export interface TextQuote {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface TextSpan {
  start: number;
  end: number;
}

/** Characters of context kept before and after a quote. */
export const QUOTE_CONTEXT = 32;

/** The quote of `[start, end)` in `text` with up to `QUOTE_CONTEXT` characters around it. */
export function quoteAt(text: string, span: TextSpan): TextQuote {
  return {
    quote: text.slice(span.start, span.end),
    prefix: text.slice(Math.max(0, span.start - QUOTE_CONTEXT), span.start),
    suffix: text.slice(span.end, span.end + QUOTE_CONTEXT),
  };
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/**
 * Where the quote stands in `text`: the occurrence whose surroundings match `prefix`/`suffix` best
 * (the first one on a tie); null when the quote is empty or not in the text.
 */
export function findQuote(text: string, anchor: TextQuote): TextSpan | null {
  const { quote } = anchor;
  if (quote === '') return null;
  let best: TextSpan | null = null;
  let bestScore = -1;
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
    const before = text.slice(Math.max(0, at - anchor.prefix.length), at);
    const after = text.slice(at + quote.length, at + quote.length + anchor.suffix.length);
    const score = commonSuffix(before, anchor.prefix) + commonPrefix(after, anchor.suffix);
    if (score > bestScore) {
      best = { start: at, end: at + quote.length };
      bestScore = score;
    }
  }
  return best;
}

/** Characters of `root`'s text before the boundary point (`node`, `offset`). */
function offsetOf(root: Node, node: Node, offset: number): number {
  const range = root.ownerDocument?.createRange() ?? document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * Text offsets of `range` inside `root`, clipped to it; null when the range does not start inside
 * `root` or covers none of its text.
 */
export function spanOfRange(root: Node, range: Range): TextSpan | null {
  if (!root.contains(range.startContainer)) return null;
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = root.contains(range.endContainer)
    ? offsetOf(root, range.endContainer, range.endOffset)
    : (root.textContent ?? '').length;
  return end > start ? { start, end } : null;
}

/** A `Range` over `[start, end)` of `root`'s text; null when the span lies outside it. */
export function rangeOfSpan(root: Node, span: TextSpan): Range | null {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let seen = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && span.start < seen + length) {
      range.setStart(node, span.start - seen);
      started = true;
    }
    if (started && span.end <= seen + length) {
      range.setEnd(node, span.end - seen);
      return range;
    }
    seen += length;
  }
  return null;
}
