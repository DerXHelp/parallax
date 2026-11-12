import { lazy, memo, Suspense } from 'react';
import { cn } from '@web/lib/cn';

/**
 * Markdown for assistant text, plans and option previews (also the `Markdown` feature slot for
 * WP-16). The renderer (react-markdown + remark-gfm) is a lazy chunk (architecture §2.3j); until it
 * has loaded the text shows as plain text – never as HTML.
 */

const loadRenderer = () => import('./MarkdownRenderer');
const MarkdownRenderer = lazy(() => loadRenderer().then((module) => ({ default: module.MarkdownRenderer })));

/** Starts loading the Markdown chunk early (TranscriptView mounts). */
export function preloadMarkdown(): void {
  loadRenderer().catch(() => undefined);
}

export interface MarkdownProps {
  text: string;
  /** The text is still streaming: the last block may end in an open code fence. */
  streaming?: boolean;
  /**
   * Host of blob links (R1W-20) and of file references (WP-55): without it no path becomes a
   * `FileLink`.
   */
  sessionKey?: string;
  /** Directory relative file references resolve against (Markdown file viewer); default: the cwd. */
  baseDir?: string;
  className?: string;
}

function PlainText({ text }: { text: string }) {
  return <div className="break-words whitespace-pre-wrap">{text}</div>;
}

export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  sessionKey,
  baseDir,
  className,
}: MarkdownProps) {
  return (
    <div data-slot="markdown" className={cn('text-ui min-w-0 leading-relaxed break-words', className)}>
      <Suspense fallback={<PlainText text={text} />}>
        <MarkdownRenderer text={text} streaming={streaming} sessionKey={sessionKey} baseDir={baseDir} />
      </Suspense>
    </div>
  );
});
