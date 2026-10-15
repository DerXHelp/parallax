import { memo, useMemo, type CSSProperties } from 'react';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import type { HighlightedLine } from '../lib/highlight';
import type { LanguageId } from '../lib/languages';
import { CopyButton } from './CopyButton';
import { useHighlight } from './use-highlight';

/**
 * Shiki's CSS-variables theme mapped to the design tokens (index.css): highlighting follows
 * dark/light without re-highlighting and uses no raw colors.
 */
export const SHIKI_TOKENS = [
  '[--shiki-foreground:var(--foreground)] [--shiki-background:transparent]',
  '[--shiki-token-keyword:var(--profile-violet)] [--shiki-token-string:var(--success)]',
  '[--shiki-token-string-expression:var(--success)] [--shiki-token-comment:var(--muted-foreground)]',
  '[--shiki-token-constant:var(--info)] [--shiki-token-function:var(--warning)]',
  '[--shiki-token-parameter:var(--foreground)] [--shiki-token-punctuation:var(--muted-foreground)]',
  '[--shiki-token-link:var(--info)] [--shiki-token-inserted:var(--success)] [--shiki-token-deleted:var(--destructive)]',
].join(' ');

function tokenStyle(color: string | null, fontStyle: number): CSSProperties | undefined {
  if (color === null && fontStyle === 0) return undefined;
  return {
    color: color ?? undefined,
    fontStyle: (fontStyle & 1) === 1 ? 'italic' : undefined,
    fontWeight: (fontStyle & 2) === 2 ? 600 : undefined,
    textDecoration: (fontStyle & 4) === 4 ? 'underline' : undefined,
  };
}

function HighlightedCode({ lines }: { lines: readonly HighlightedLine[] }) {
  return lines.map((line, index) => (
    <span key={index} className="block min-h-[1lh]">
      {line.map((token, tokenIndex) => (
        <span key={tokenIndex} style={tokenStyle(token.color, token.fontStyle)}>
          {token.content}
        </span>
      ))}
    </span>
  ));
}

function PlainCode({ code }: { code: string }) {
  const lines = useMemo(() => code.split('\n'), [code]);
  return lines.map((line, index) => (
    <span key={index} className="block min-h-[1lh]">
      {line}
    </span>
  ));
}

export interface CodeBlockProps {
  code: string;
  language: LanguageId | null;
  /** Label in the header (fence info or file name); default: the language or "Text". */
  label?: string | null;
  /** False while the fence is still streaming (no highlighting yet). */
  highlight?: boolean;
  /** Line numbers starting at this line (Read); null = none. */
  startLine?: number | null;
  /** Without header (copy button floats). */
  bare?: boolean;
  className?: string;
  /** Max height class of the scroll area. */
  maxHeightClassName?: string;
}

/** Code with copy button and lazy Shiki highlighting (architecture §2.3j). Text only – never HTML. */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  label,
  highlight = true,
  startLine = null,
  bare = false,
  className,
  maxHeightClassName = 'max-h-96',
}: CodeBlockProps) {
  const t = useT();
  const lines = useHighlight(code, language, highlight);
  const lineCount = useMemo(() => (startLine === null ? 0 : code.split('\n').length), [code, startLine]);
  const title = label ?? language ?? t('transcript.code.plain');
  return (
    <div
      data-slot="code-block"
      data-highlighted={lines === null ? undefined : 'true'}
      className={cn('group/code bg-muted/40 relative min-w-0 rounded-md border', className)}
    >
      {bare ? null : (
        <div className="text-muted-foreground flex h-6 items-center gap-2 border-b pr-1 pl-2.5 text-2xs">
          <span className="min-w-0 flex-1 truncate font-mono">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <div className={cn('flex overflow-auto', maxHeightClassName)}>
        {startLine === null ? null : (
          <div
            aria-hidden
            className="text-muted-foreground/70 sticky left-0 shrink-0 border-r bg-inherit py-2 pr-2 pl-2.5 text-right font-mono text-2xs leading-5 select-none"
          >
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index} className="block">
                {startLine + index}
              </span>
            ))}
          </div>
        )}
        <pre
          className={`min-w-0 flex-1 px-3 py-2 font-mono text-xs leading-5 [font-variant-ligatures:none] ${SHIKI_TOKENS}`}
        >
          <code className="text-foreground">
            {lines === null ? <PlainCode code={code} /> : <HighlightedCode lines={lines} />}
          </code>
        </pre>
      </div>
      {bare ? (
        <div className="absolute top-1 right-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
          <CopyButton text={code} />
        </div>
      ) : null}
    </div>
  );
});
