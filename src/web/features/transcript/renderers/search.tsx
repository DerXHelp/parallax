import { FolderSearchIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ToolCallItem } from '@shared/model';
import { useT } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { Button } from '@web/ui/button';
import { CappedContent } from '../components/CappedContent';
import { resultText, stripToolUseError } from '../lib/text';
import { readGlobInput, readGrepInput, readSearchResult } from '../lib/tool-input';
import { GenericToolBody } from './generic';
import { TerminalOutput } from './parts';
import type { ToolBodyProps, ToolRenderer, Translate } from './types';

/**
 * Grep / Glob as a result list. Live results carry `{ mode, filenames, numFiles, numLines … }`; the
 * history only has the CLI text (file per line, `path:line:text` in content mode, a leading
 * "Found N files"), so the list is parsed from the text when `structured` is missing.
 */

const PAGE = 100;
const HEADER_LINE = /^(?:Found \d+ (?:files?|matches|lines?)|No (?:files|matches) found\.?)/i;
const CONTENT_LINE = /^(.*?):(\d+)[:-](.*)$/;

interface FileGroup {
  path: string;
  lines: { line: number; text: string }[];
}

type Parsed =
  | { kind: 'files'; files: string[] }
  | { kind: 'content'; groups: FileGroup[]; count: number }
  | { kind: 'empty' }
  | { kind: 'raw' };

export function parseSearchText(text: string, mode: string | undefined): Parsed {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '' && !HEADER_LINE.test(line.trim()));
  if (lines.length === 0) return { kind: 'empty' };
  if (mode === 'content') {
    const groups: FileGroup[] = [];
    for (const line of lines) {
      const match = CONTENT_LINE.exec(line);
      if (match === null) return { kind: 'raw' };
      const path = match[1] ?? '';
      const last = groups.at(-1);
      const entry = { line: Number(match[2]), text: match[3] ?? '' };
      if (last?.path === path) last.lines.push(entry);
      else groups.push({ path, lines: [entry] });
    }
    return { kind: 'content', groups, count: lines.length };
  }
  if (mode === 'count') return { kind: 'raw' };
  return { kind: 'files', files: lines };
}

function modeOf(item: ToolCallItem): string | undefined {
  const structured = readSearchResult(item.result?.structured ?? null);
  if (structured?.mode !== undefined) return structured.mode;
  if (item.toolName === 'Glob') return 'files_with_matches';
  return readGrepInput(item.input)?.output_mode ?? 'files_with_matches';
}

function FileList({ files }: { files: readonly string[] }) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE);
  const hidden = files.length - Math.min(limit, files.length);
  return (
    <div className="bg-muted/30 min-w-0 rounded-md border">
      <ul className="max-h-72 overflow-auto py-1 font-mono text-xs leading-5">
        {files.slice(0, limit).map((file, index) => (
          <li key={index} title={file} className="truncate px-2.5">
            {shortPath(file, 4)}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <div className="border-t px-2 py-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLimit((current) => current + PAGE * 5);
            }}
          >
            {t('transcript.search.more', { count: hidden })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ContentList({ groups }: { groups: readonly FileGroup[] }) {
  const t = useT();
  const [limit, setLimit] = useState(PAGE / 4);
  const hidden = groups.length - Math.min(limit, groups.length);
  return (
    <div className="bg-muted/30 min-w-0 rounded-md border">
      <div className="max-h-80 overflow-auto py-1 font-mono text-xs leading-5">
        {groups.slice(0, limit).map((group, index) => (
          <div key={index} className="px-2.5 pb-1">
            <div title={group.path} className="text-info truncate">
              {shortPath(group.path, 4)}
            </div>
            {group.lines.map((line, lineIndex) => (
              <div key={lineIndex} className="flex gap-2 whitespace-pre">
                <span className="text-muted-foreground/70 w-10 shrink-0 text-right select-none">
                  {line.line}
                </span>
                <span className="min-w-0">{line.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      {hidden > 0 ? (
        <div className="border-t px-2 py-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLimit((current) => current + PAGE);
            }}
          >
            {t('transcript.search.more', { count: hidden })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SearchBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const { text, truncated } = resultText(item);
  const mode = modeOf(item);
  const structured = readSearchResult(item.result?.structured ?? null);
  const parsed = useMemo(() => parseSearchText(text, mode), [text, mode]);
  const known = item.toolName === 'Glob' ? readGlobInput(item.input) : readGrepInput(item.input);
  if (known === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  if (item.result === null) return null;
  if (item.result.isError) return <TerminalOutput text={stripToolUseError(text)} tone="error" />;
  const files = structured?.filenames !== undefined && mode !== 'content' ? structured.filenames : null;
  return (
    <>
      <CappedContent text={text} truncated={truncated} sessionKey={sessionKey}>
        {(value) => {
          if (files !== null && value === text) {
            return files.length === 0 ? (
              <p className="text-muted-foreground text-xs italic">{t('transcript.search.noResults')}</p>
            ) : (
              <FileList files={files} />
            );
          }
          const view = value === text ? parsed : parseSearchText(value, mode);
          switch (view.kind) {
            case 'empty':
              return (
                <p className="text-muted-foreground text-xs italic">{t('transcript.search.noResults')}</p>
              );
            case 'files':
              return <FileList files={view.files} />;
            case 'content':
              return <ContentList groups={view.groups} />;
            case 'raw':
              return <TerminalOutput text={value} />;
          }
        }}
      </CappedContent>
      {structured?.truncated === true ? (
        <p className="text-muted-foreground text-2xs">{t('transcript.search.truncated')}</p>
      ) : null}
    </>
  );
}

function countMeta(item: ToolCallItem, t: Translate): string | null {
  if (item.result === null || item.result.isError) return null;
  const structured = readSearchResult(item.result.structured);
  const mode = modeOf(item);
  if (mode === 'content') {
    const lines = structured?.numLines;
    return lines === undefined ? null : t('transcript.search.lines', { count: lines });
  }
  if (mode === 'count') {
    const matches = structured?.numMatches;
    return matches === undefined ? null : t('transcript.search.matches', { count: matches });
  }
  const files = structured?.numFiles ?? structured?.filenames?.length;
  if (files !== undefined) return t('transcript.search.files', { count: files });
  const view = parseSearchText(resultText(item).text, mode);
  if (view.kind === 'files') return t('transcript.search.files', { count: view.files.length });
  if (view.kind === 'empty') return t('transcript.search.noResults');
  return null;
}

export const grepRenderer: ToolRenderer = {
  icon: SearchIcon,
  summary: (item, t) => {
    const input = readGrepInput(item.input);
    if (input === null) return null;
    const where = input.path ?? input.glob;
    return where === undefined
      ? input.pattern
      : `${input.pattern} ${t('transcript.search.in', { path: shortPath(where, 3) })}`;
  },
  meta: countMeta,
  Body: SearchBody,
};

export const globRenderer: ToolRenderer = {
  icon: FolderSearchIcon,
  summary: (item, t) => {
    const input = readGlobInput(item.input);
    if (input === null) return null;
    return input.path === undefined
      ? input.pattern
      : `${input.pattern} ${t('transcript.search.in', { path: shortPath(input.path, 3) })}`;
  },
  meta: countMeta,
  Body: SearchBody,
};
