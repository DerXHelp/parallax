/**
 * WP-93 (ADR-234): marks annotated passages of a plan with the CSS Custom Highlight API – ranges
 * over the rendered text, no change to the DOM React owns (styles `::highlight(...)` in index.css).
 * Several plan views may be mounted (side panel, inline card): each owner sets its ranges, the
 * registry draws the union. Without the API (happy-dom, old engines) nothing is marked – the notes
 * below the passages still show every annotation.
 */

export const HIGHLIGHT_KINDS = ['plan-annotation', 'plan-strike', 'plan-annotation-active'] as const;
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];
export type HighlightRanges = Readonly<Record<HighlightKind, readonly Range[]>>;

const owners = new Map<string, HighlightRanges>();

export function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
}

/** Replaces the ranges of `owner` (null removes them) and redraws every kind. */
export function setHighlights(owner: string, ranges: HighlightRanges | null): void {
  if (ranges === null) owners.delete(owner);
  else owners.set(owner, ranges);
  if (!supportsHighlights()) return;
  for (const kind of HIGHLIGHT_KINDS) {
    const all = [...owners.values()].flatMap((entry) => entry[kind]);
    if (all.length === 0) CSS.highlights.delete(kind);
    else CSS.highlights.set(kind, new Highlight(...all));
  }
}
