import type { BlobRef, CappedText, ToolCallItem, ToolResultContent } from '@shared/model';
import { readFilePathInput } from './tool-input';

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

/**
 * Inline budget of a loaded full text (R2W-06): a multi-MB build log or file would freeze the
 * renderer (ANSI scan, one huge text node / thousands of line spans). Beyond it the view is clipped.
 */
export const INLINE_TEXT_BUDGET = { chars: 1024 * 1024, lines: 20_000 } as const;

export interface ClippedText {
  text: string;
  /** True when `text` is only the start of the input. */
  clipped: boolean;
}

/** The start of `text` within the budget (cut at a line end when the line budget is hit). */
export function clipForDisplay(
  text: string,
  budget: { chars: number; lines: number } = INLINE_TEXT_BUDGET,
): ClippedText {
  let end = Math.min(text.length, budget.chars);
  let lines = 0;
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    lines++;
    if (lines >= budget.lines) {
      end = i;
      break;
    }
  }
  return end >= text.length ? { text, clipped: false } : { text: text.slice(0, end), clipped: true };
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
export function resultImages(item: ToolCallItem): BlobRef[] {
  return (item.result?.content ?? []).flatMap((part) => (part.type === 'image' ? [part.image] : []));
}

const EMPTY_IMAGES: readonly BlobRef[] = Object.freeze([]);
const previewCache = new WeakMap<ToolCallItem, readonly BlobRef[]>();

/** Last segment of a Windows or POSIX path (`C:\shots\a.png` → `a.png`). */
function baseName(path: string): string {
  return path.split(/[\\/]/).findLast((segment) => segment !== '') ?? '';
}

/**
 * The pictures of a tool result as the transcript previews them (R4W-03, V3-09): only `image/*`
 * blobs; an image without its own name is named after the tool's `input.file_path` (Read of a
 * screenshot), so thumbnail, lightbox title and "Save as" show the file name instead of "unnamed".
 * Cached per item (stable array for memoized rows).
 */
export function previewImages(item: ToolCallItem): readonly BlobRef[] {
  const cached = previewCache.get(item);
  if (cached !== undefined) return cached;
  const images = resultImages(item).filter((image) => image.mediaType.startsWith('image/'));
  let result: readonly BlobRef[] = EMPTY_IMAGES;
  if (images.length > 0) {
    const input = readFilePathInput(item.input);
    const name = input === null ? '' : baseName(input.file_path).trim();
    result =
      name === ''
        ? images
        : images.map((image) => ((image.name ?? '').trim() === '' ? { ...image, name } : image));
  }
  previewCache.set(item, result);
  return result;
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
