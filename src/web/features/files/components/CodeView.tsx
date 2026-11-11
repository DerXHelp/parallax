import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { cn } from '@web/lib/cn';
import type { HighlightedLine } from '@web/lib/highlight';
import type { LanguageId } from '@web/lib/languages';
import { SHIKI_TOKENS } from '@web/ui/code-block';
import { useHighlight } from '@web/ui/use-highlight';

/**
 * Virtualized code view of the viewer (WP-54, lazy chunk): one row per line with its number, Shiki
 * colors up to HIGHLIGHT_MAX_CHARS (ui/use-highlight, plain text above), no wrapping (horizontal
 * scroll, sticky numbers). A `line` is scrolled to the middle, marked (`aria-current`) and the view
 * takes the focus when the focus is in the side panel (or nowhere) – keyboard scrolling works at once.
 * The scroll position survives new text (live reload): the rows change, the list stays.
 */

export const CODE_LINE_HEIGHT = 20;

/** Frames to wait for virtua's viewport measurement before the line jump. */
const JUMP_MAX_FRAMES = 10;

export interface CodeViewProps {
  text: string;
  language: LanguageId | null;
  /** 1-based line to jump to; null = none. */
  line?: number | null;
  /** Accessible name of the scroll region. */
  label: string;
  className?: string;
}

function tokenStyle(color: string | null, fontStyle: number): CSSProperties | undefined {
  if (color === null && fontStyle === 0) return undefined;
  return {
    color: color ?? undefined,
    fontStyle: (fontStyle & 1) === 1 ? 'italic' : undefined,
    fontWeight: (fontStyle & 2) === 2 ? 600 : undefined,
    textDecoration: (fontStyle & 4) === 4 ? 'underline' : undefined,
  };
}

function LineContent({ plain, tokens }: { plain: string; tokens: HighlightedLine | undefined }) {
  if (tokens === undefined) return plain;
  return tokens.map((token, index) => (
    <span key={index} style={tokenStyle(token.color, token.fontStyle)}>
      {token.content}
    </span>
  ));
}

/** Width of the longest line in `ch` (tabs count 4, like `tab-size`). */
function longestLine(lines: readonly string[]): number {
  let longest = 0;
  for (const line of lines) {
    let width = line.length;
    for (let index = line.indexOf('\t'); index !== -1; index = line.indexOf('\t', index + 1)) width += 3;
    if (width > longest) longest = width;
  }
  return longest;
}

function focusAllowed(element: HTMLElement): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  return element.closest('[data-slot="side-panel"]')?.contains(active) === true;
}

export const CodeView = memo(function CodeView({
  text,
  language,
  line = null,
  label,
  className,
}: CodeViewProps) {
  const normalized = useMemo(() => text.replace(/\r\n?/g, '\n'), [text]);
  const lines = useMemo(() => normalized.split('\n'), [normalized]);
  const highlighted = useHighlight(normalized, language, true);
  const gutter = String(lines.length).length;
  const width = useMemo(() => longestLine(lines), [lines]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const handle = useRef<VirtualizerHandle>(null);
  const target = line !== null && line >= 1 && line <= lines.length ? line : null;

  // Jump once per target (a live reload keeps the position the reader scrolled to).
  const jumped = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (target === null || jumped.current === target) return;
    jumped.current = target;
    const region = scrollRef.current;
    if (region !== null && focusAllowed(region)) region.focus({ preventScroll: true });
    let frames = 0;
    const jump = () => {
      const list = handle.current;
      if (list === null) return;
      // virtua ignores scrollToIndex until its ResizeObserver measured the viewport (after the first
      // layout of a freshly mounted view) – wait for it a few frames.
      if (list.viewportSize === 0 && frames < JUMP_MAX_FRAMES) {
        frames += 1;
        requestAnimationFrame(jump);
        return;
      }
      list.scrollToIndex(target - 1, { align: 'center' });
    };
    jump();
  }, [target]);

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      data-slot="code-view"
      data-highlighted={highlighted === null ? undefined : 'true'}
      className={cn(
        'focus-visible:ring-ring min-h-0 flex-1 overflow-auto font-mono text-xs leading-5 outline-none [font-variant-ligatures:none] [tab-size:4] focus-visible:ring-2 focus-visible:ring-inset',
        SHIKI_TOKENS,
        className,
      )}
    >
      <div style={{ minWidth: `calc(${String(width + gutter)}ch + 2.5rem)` }} className="py-1">
        <Virtualizer ref={handle} scrollRef={scrollRef} data={lines} itemSize={CODE_LINE_HEIGHT}>
          {(plain, index) => {
            const number = index + 1;
            const current = number === target;
            return (
              <div
                key={index}
                data-line={number}
                aria-current={current ? 'true' : undefined}
                className={cn('flex min-h-5', current ? 'bg-warning/15' : 'hover:bg-muted/40')}
              >
                <span
                  aria-hidden
                  style={{ width: `calc(${String(gutter)}ch + 1rem)` }}
                  className={cn(
                    // Opaque: the code scrolls underneath the sticky numbers.
                    'sticky left-0 shrink-0 border-r pr-2 text-right select-none',
                    current
                      ? 'bg-muted text-foreground font-semibold'
                      : 'bg-background text-muted-foreground/70',
                  )}
                >
                  {number}
                </span>
                <span className="text-foreground pr-3 pl-3 whitespace-pre">
                  <LineContent plain={plain} tokens={highlighted?.[index]} />
                </span>
              </div>
            );
          }}
        </Virtualizer>
      </div>
    </div>
  );
});

export default CodeView;
