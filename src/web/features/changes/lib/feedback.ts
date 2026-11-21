import type { ReviewComment } from '@shared/model';
import type { TranslationKey, TranslationParams } from '@web/i18n';

/**
 * WP-113 (ADR-254): "Send to Claude" – the open review comments as one numbered list in the style
 * of `web/lib/plan-feedback.ts`: an intro, then per comment its place (`path:line` or
 * `path:from-to`, the old side marked), the quoted lines and the comment. Claude reads it as a paste
 * chip of the composer; the user adds text around it. Texts from `changes.feedback` (the user's
 * language). Pure.
 */

type Translate = (key: TranslationKey, params?: TranslationParams) => string;

/** Quoted lines per comment in the message (more → "…"). */
export const FEEDBACK_QUOTE_LINES = 12;
/** Characters of one quote in the message (more → "…"). */
export const FEEDBACK_QUOTE_CHARS = 1500;

/** File order (path), then the new side before the old one, then the line, then creation time. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.side === b.side ? 0 : a.side === 'new' ? -1 : 1) ||
      a.line - b.line ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

/** `path:12` or `path:12-14` (plain digits – a place, not a number to format). */
export function commentLocation(comment: Pick<ReviewComment, 'path' | 'line' | 'endLine'>): string {
  const lines =
    comment.endLine > comment.line
      ? `${String(comment.line)}-${String(comment.endLine)}`
      : String(comment.line);
  return `${comment.path}:${lines}`;
}

function quoteLines(quote: string): string[] {
  if (quote.trim() === '') return [];
  const text = quote.length > FEEDBACK_QUOTE_CHARS ? `${quote.slice(0, FEEDBACK_QUOTE_CHARS)}…` : quote;
  let lines = text.split('\n');
  if (lines.length > FEEDBACK_QUOTE_LINES) lines = [...lines.slice(0, FEEDBACK_QUOTE_LINES), '…'];
  return lines.map((line) => `   > ${line}`.trimEnd());
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `   ${line}`))
    .join('\n');
}

/** The message: intro and the numbered comments; '' without comments. */
export function buildReviewFeedback(comments: readonly ReviewComment[], t: Translate): string {
  if (comments.length === 0) return '';
  const entries = sortComments(comments).map((comment, index) => {
    const place = commentLocation(comment);
    const head = `${String(index + 1)}. ${comment.side === 'old' ? `${place} ${t('changes.feedback.old')}` : place}`;
    return [head, ...quoteLines(comment.quote), indent(comment.text.trim())].join('\n');
  });
  return [t('changes.feedback.intro', { count: comments.length }), ...entries].join('\n\n');
}
