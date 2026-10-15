import type { CappedText, ToolCallItem, ToolResultContent } from '@shared/model';

/**
 * Text helpers of the transcript renderers (display only).
 */

/**
 * Terminal output for display: CRLF → LF (PowerShell, F.4) and carriage-return overwrites
 * (progress bars) keep the last visible state of a line.
 */
export function normalizeTerminalText(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  if (!lf.includes('\r')) return lf;
  return lf
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if (part !== undefined && part !== '') return part;
      }
      return '';
    })
    .join('\n');
}

/** Number of lines of a text (an empty text has 0, a trailing newline does not count). */
export function countLines(text: string): number {
  if (text === '') return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return text.endsWith('\n') ? count - 1 : count;
}

/** The text parts of a tool result, joined by newlines; the first capped part wins `truncated`. */
export interface ResultText {
  text: string;
  truncated: CappedText['truncated'];
  /** Number of text parts (0 = only images or nothing). */
  parts: number;
}

const EMPTY_RESULT: ResultText = { text: '', truncated: null, parts: 0 };
const resultTextCache = new WeakMap<readonly ToolResultContent[], ResultText>();

export function resultText(item: ToolCallItem): ResultText {
  const content = item.result?.content;
  if (content === undefined || content.length === 0) return EMPTY_RESULT;
  const cached = resultTextCache.get(content);
  if (cached !== undefined) return cached;
  const texts: string[] = [];
  let truncated: CappedText['truncated'] = null;
  for (const part of content) {
    if (part.type !== 'text') continue;
    texts.push(part.text.text);
    truncated ??= part.text.truncated;
  }
  const result: ResultText = { text: texts.join('\n'), truncated, parts: texts.length };
  resultTextCache.set(content, result);
  return result;
}

/** The image parts of a tool result (blobs). */
export function resultImages(item: ToolCallItem) {
  return (item.result?.content ?? []).flatMap((part) => (part.type === 'image' ? [part.image] : []));
}

/** `<tool_use_error>…</tool_use_error>` wrappers of CLI error results → inner text. */
export function stripToolUseError(text: string): string {
  const match = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/.exec(text.trim());
  return match?.[1] ?? text;
}

/** First line of a text, shortened for one-line summaries. */
export function firstLine(text: string, max = 160): string {
  const line = text.trimStart().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
