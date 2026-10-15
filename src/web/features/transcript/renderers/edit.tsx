import { FilePenIcon, FilePlusIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { JsonValue } from '@shared/common';
import type { ToolCallItem } from '@shared/model';
import { useT } from '@web/i18n';
import { shortPath } from '@web/lib/path-display';
import { Spinner } from '@web/ui/spinner';
import { DiffView } from '../components/DiffView';
import {
  computeFallbackRows,
  contentToRows,
  diffStats,
  hunksToRows,
  peekFallbackRows,
  type DiffRow,
} from '../lib/diff';
import {
  readEditInput,
  readMultiEditInput,
  readPatchResult,
  readWriteInput,
  type EditInput,
} from '../lib/tool-input';
import { countLines } from '../lib/text';
import { GenericToolBody, GenericToolPreview } from './generic';
import { InputCapNotice, ToolResultText, useToolInput } from './parts';
import type { ToolBodyProps, ToolPreviewProps, ToolRenderer, Translate } from './types';

/**
 * Edit / MultiEdit / Write as a diff (F.4): from `structuredPatch` of the live result; without it
 * (history, A.3: `structured` null; permission previews) jsdiff on `old_string`/`new_string`
 * (lazy chunk) – line numbers then count from the snippet. Write `create` (empty patch) and
 * Write without result are shown as a new file from `content`.
 */

/** Diffs up to this many changed lines open by default. */
const OPEN_BY_DEFAULT_MAX = 40;

function patchRows(item: ToolCallItem): DiffRow[] | null {
  const hunks = readPatchResult(item.result?.structured ?? null)?.structuredPatch;
  return hunks === undefined || hunks.length === 0 ? null : hunksToRows(hunks);
}

const patchRowsCache = new WeakMap<ToolCallItem, DiffRow[] | null>();
function cachedPatchRows(item: ToolCallItem): DiffRow[] | null {
  if (patchRowsCache.has(item)) return patchRowsCache.get(item) ?? null;
  const rows = patchRows(item);
  patchRowsCache.set(item, rows);
  return rows;
}

/** Pairs of snippets of an Edit/MultiEdit input. */
function editPairs(input: JsonValue): EditInput[] | null {
  const edit = readEditInput(input);
  if (edit !== null) return [edit];
  const multi = readMultiEditInput(input);
  if (multi === null) return null;
  return multi.edits.map((e) => ({ file_path: multi.file_path, ...e }));
}

/** jsdiff fallback for snippet pairs (cached per pair, lazy `diff` chunk). */
function useFallbackRows(pairs: readonly EditInput[] | null): DiffRow[] | null {
  const peeked = useMemo(() => {
    if (pairs === null) return null;
    const rows: DiffRow[] = [];
    for (const pair of pairs) {
      const cached = peekFallbackRows(pair.old_string, pair.new_string);
      if (cached === null) return null;
      rows.push(...cached);
    }
    return rows;
  }, [pairs]);
  const [computed, setComputed] = useState<{ pairs: readonly EditInput[]; rows: DiffRow[] } | null>(null);

  useEffect(() => {
    if (pairs === null || peeked !== null) return undefined;
    let cancelled = false;
    Promise.all(pairs.map((pair) => computeFallbackRows(pair.old_string, pair.new_string))).then(
      (parts) => {
        if (!cancelled) setComputed({ pairs, rows: parts.flat() });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [pairs, peeked]);

  if (peeked !== null) return peeked;
  return computed !== null && computed.pairs === pairs ? computed.rows : null;
}

function DiffBody({
  rows,
  snippet,
  replaceAll,
  editCount,
}: {
  rows: DiffRow[] | null;
  snippet: boolean;
  replaceAll: boolean;
  editCount: number;
}) {
  const t = useT();
  if (rows === null) {
    return (
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <Spinner className="size-3" label={t('transcript.edit.computing')} />
        {t('transcript.edit.computing')}
      </p>
    );
  }
  return (
    <div className="grid min-w-0 gap-1">
      {replaceAll || editCount > 1 || snippet ? (
        <p className="text-muted-foreground flex flex-wrap gap-x-3 text-2xs">
          {editCount > 1 ? <span>{t('transcript.edit.editCount', { count: editCount })}</span> : null}
          {replaceAll ? <span>{t('transcript.edit.replaceAll')}</span> : null}
          {snippet ? <span>{t('transcript.edit.snippet')}</span> : null}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">{t('transcript.edit.noChanges')}</p>
      ) : (
        <DiffView rows={rows} />
      )}
    </div>
  );
}

function EditBody({ item, sessionKey }: ToolBodyProps) {
  const input = useToolInput(item);
  const pairs = useMemo(() => editPairs(input), [input]);
  const fromPatch = cachedPatchRows(item);
  const fallback = useFallbackRows(fromPatch === null ? pairs : null);
  if (pairs === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  const rows = fromPatch ?? fallback;
  return (
    <>
      <DiffBody
        rows={rows}
        snippet={fromPatch === null}
        replaceAll={pairs.some((pair) => pair.replace_all === true)}
        editCount={pairs.length}
      />
      <InputCapNotice item={item} sessionKey={sessionKey} />
      {item.result?.isError === true ? <ToolResultText item={item} sessionKey={sessionKey} /> : null}
    </>
  );
}

function writeKind(item: ToolCallItem): 'newFile' | 'overwritten' | 'written' {
  const type = readPatchResult(item.result?.structured ?? null)?.type;
  if (type === 'create') return 'newFile';
  if (type === 'update') return 'overwritten';
  return item.result === null ? 'newFile' : 'written';
}

function WriteBody({ item, sessionKey }: ToolBodyProps) {
  const t = useT();
  const input = readWriteInput(useToolInput(item));
  const fromPatch = cachedPatchRows(item);
  const content = input?.content ?? null;
  const contentRows = useMemo(() => (content === null ? null : contentToRows(content)), [content]);
  if (input === null) return <GenericToolBody item={item} sessionKey={sessionKey} />;
  const kind = writeKind(item);
  const rows = kind === 'overwritten' && fromPatch !== null ? fromPatch : contentRows;
  return (
    <>
      <p className="text-muted-foreground text-2xs">{t(`transcript.edit.${kind}`)}</p>
      {rows === null || rows.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">{t('transcript.read.empty')}</p>
      ) : (
        <DiffView rows={rows} showOldLines={rows !== fromPatch} />
      )}
      <InputCapNotice item={item} sessionKey={sessionKey} />
      {item.result?.isError === true ? <ToolResultText item={item} sessionKey={sessionKey} /> : null}
    </>
  );
}

function pathSummary(item: ToolCallItem): string | null {
  const input = item.input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const path = input.file_path;
  return typeof path === 'string' ? shortPath(path, 3) : null;
}

function statsMeta(rows: readonly DiffRow[] | null, t: Translate): string | null {
  if (rows === null) return null;
  const { added, removed } = diffStats(rows);
  return added === 0 && removed === 0 ? null : t('transcript.edit.stats', { added, removed });
}

function EditPreview({ toolName, input }: ToolPreviewProps) {
  const pairs = useMemo(() => editPairs(input), [input]);
  const rows = useFallbackRows(pairs);
  if (pairs === null) return <GenericToolPreview toolName={toolName} input={input} />;
  return (
    <DiffBody
      rows={rows}
      snippet
      replaceAll={pairs.some((pair) => pair.replace_all === true)}
      editCount={pairs.length}
    />
  );
}

function WritePreview({ toolName, input }: ToolPreviewProps) {
  const t = useT();
  const parsed = readWriteInput(input);
  const rows = useMemo(() => (parsed === null ? null : contentToRows(parsed.content)), [parsed]);
  if (parsed === null || rows === null) return <GenericToolPreview toolName={toolName} input={input} />;
  return (
    <div className="grid min-w-0 gap-1">
      <p className="text-muted-foreground text-2xs">{t('transcript.edit.written')}</p>
      <DiffView rows={rows} showOldLines={false} />
    </div>
  );
}

export const editRenderer: ToolRenderer = {
  icon: FilePenIcon,
  summary: pathSummary,
  meta: (item, t) => statsMeta(cachedPatchRows(item), t),
  Body: EditBody,
  defaultOpen: (item) => {
    const rows = cachedPatchRows(item);
    if (rows === null) return false;
    const { added, removed } = diffStats(rows);
    return added + removed <= OPEN_BY_DEFAULT_MAX;
  },
  Preview: EditPreview,
};

export const writeRenderer: ToolRenderer = {
  icon: FilePlusIcon,
  summary: pathSummary,
  meta: (item, t) => {
    const input = readWriteInput(item.input);
    if (input === null) return null;
    const fromPatch = cachedPatchRows(item);
    if (writeKind(item) === 'overwritten' && fromPatch !== null) return statsMeta(fromPatch, t);
    return t('transcript.read.lines', { count: countLines(input.content) });
  },
  Body: WriteBody,
  Preview: WritePreview,
};
