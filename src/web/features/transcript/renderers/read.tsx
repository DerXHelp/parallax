import { FileTextIcon } from 'lucide-react';
import { useMemo } from 'react';
import type { ToolCallItem } from '@shared/model';
import { useT } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { CappedContent } from '../components/CappedContent';
import { CodeBlock } from '../components/CodeBlock';
import { languageForPath } from '../lib/languages';
import { previewImages, resultText, stripToolUseError } from '../lib/text';
import { readReadInput, readReadResult } from '../lib/tool-input';
import { GenericToolBody } from './generic';
import { TerminalOutput } from './parts';
import type { ToolBodyProps, ToolRenderer, Translate } from './types';

/**
 * Read: file + line range (F.4: `{ type:'text', file:{ filePath, numLines, startLine, totalLines } }`
 * live; in the history only the input `offset`/`limit`). The tool result is the CLI's numbered
 * listing (`<n>\t<line>`) – shown as code with a line-number gutter. Images come as blobs; the
 * row shows them below its line (`ToolResultImages`, R4W-03), named after `file_path`.
 */

const NUMBERED_LINE = /^\s*(\d+)(?:\t|→)(.*)$/;

/** `   12\tfoo` lines → start line + plain code; null when the text is not a numbered listing. */
export function parseNumberedListing(text: string): { startLine: number; code: string } | null {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return null;
  const code: string[] = [];
  let start: number | null = null;
  for (const line of lines) {
    const match = NUMBERED_LINE.exec(line);
    if (match === null) return null;
    start ??= Number(match[1]);
    code.push(match[2] ?? '');
  }
  return start === null ? null : { startLine: start, code: code.join('\n') };
}

interface Range {
  from: number;
  to: number | null;
  total: number | null;
}

function rangeOf(item: ToolCallItem): Range | null {
  const file = readReadResult(item.result?.structured ?? null)?.file;
  if (file?.startLine !== undefined && file.numLines !== undefined) {
    return {
      from: file.startLine,
      to: file.startLine + Math.max(0, file.numLines - 1),
      total: file.totalLines ?? null,
    };
  }
  const input = readReadInput(item.input);
  if (input === null || (input.offset === undefined && input.limit === undefined)) return null;
  const from = input.offset ?? 1;
  return { from, to: input.limit === undefined ? null : from + input.limit - 1, total: null };
}

function rangeText(range: Range, t: Translate): string {
  if (range.to === null) return t('transcript.read.from', { from: range.from });
  if (range.total === null) return t('transcript.read.rangeOpen', { from: range.from, to: range.to });
  return t('transcript.read.range', { from: range.from, to: range.to, total: range.total });
}

function ReadBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = readReadInput(item.input);
  const { text, truncated } = resultText(item);
  const listing = useMemo(() => parseNumberedListing(text), [text]);
  if (input === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  // Pictures (a Read of a screenshot) stand below the tool line, not here (R4W-03).
  const hasImages = previewImages(item).length > 0;
  if (item.result === null) return null;
  if (item.result.isError) return <TerminalOutput text={stripToolUseError(text)} tone="error" />;
  const language = languageForPath(input.file_path);
  return (
    <>
      {input.pages === undefined ? null : (
        <p className="text-muted-foreground text-2xs">{t('transcript.read.pages', { pages: input.pages })}</p>
      )}
      {text.trim() === '' ? (
        hasImages ? null : <p className="text-muted-foreground text-xs italic">{t('transcript.read.empty')}</p>
      ) : (
        <CappedContent text={text} truncated={truncated} sessionKey={sessionKey}>
          {(value) => {
            const parsed = value === text ? listing : parseNumberedListing(value);
            return parsed === null ? (
              <TerminalOutput text={value} />
            ) : (
              <CodeBlock
                code={parsed.code}
                language={language}
                label={shortPath(input.file_path, 2)}
                startLine={parsed.startLine}
              />
            );
          }}
        </CappedContent>
      )}
    </>
  );
}

export const readRenderer: ToolRenderer = {
  icon: FileTextIcon,
  summary: (item) => {
    const input = readReadInput(item.input);
    return input === null ? null : shortPath(input.file_path, 3);
  },
  meta: (item, t) => {
    const range = rangeOf(item);
    return range === null ? null : rangeText(range, t);
  },
  Body: ReadBody,
};
