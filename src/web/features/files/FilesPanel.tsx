import { memo, useMemo, useState } from 'react';
import { VList } from 'virtua';
import type { SessionFile, SessionFileOp } from '@shared/model';
import { useI18n } from '@web/i18n';
import { fuzzyFilter } from '@web/lib/fuzzy';
import { useNow } from '@web/state/clock';
import { useSummarySelector } from '@web/state/hooks';
import { Alert } from '@web/ui/alert';
import { Badge, type BadgeProps } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@web/ui/context-menu';
import { Input } from '@web/ui/input';
import { FileActionItems, FileActionsMenu } from './components/FileActionItems';
import { FileIcon } from './components/FileIcon';
import { PathText } from './components/PathText';
import { fileActions, openInViewer } from './lib/actions';
import { fileName, relativeToRoot } from './lib/paths';
import { useSessionFiles } from './state/session-files';

/**
 * Slot `FilesPanel` (WP-54, ADR-145): "Files of this session" – every file Claude read, wrote,
 * edited, planned, produced or got attached, newest first, from the host's file index
 * (`files.session`; refreshed 2 s after the last finished file tool call). Paths relative to the cwd,
 * a filter (lib/fuzzy), click → viewer, right click or "…" → the actions of FileLink.
 */

const OP_VARIANT: Readonly<Record<SessionFileOp, NonNullable<BadgeProps['variant']>>> = {
  read: 'outline',
  written: 'success',
  edited: 'info',
  plan: 'warning',
  output: 'secondary',
  attached: 'secondary',
};

export const FILES_ROW_HEIGHT = 48;

interface Row {
  file: SessionFile;
  /** Relative to the cwd, else the full path. */
  display: string;
}

const FileRow = memo(function FileRow({
  sessionKey,
  row,
  now,
}: {
  sessionKey: string;
  row: Row;
  now: number;
}) {
  const { t, format } = useI18n();
  const { file, display } = row;
  const actions = fileActions({ sessionKey, path: file.path });
  const name = fileName(file.path);
  return (
    <div
      role="listitem"
      data-slot="files-row"
      data-path={file.path}
      className="group/row hover:bg-muted/50 flex items-center gap-1 pr-2"
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            title={file.path}
            className="focus-visible:ring-ring flex min-w-0 flex-1 items-start gap-2 py-1.5 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
            onClick={() => {
              openInViewer({ sessionKey, path: file.path });
            }}
          >
            <FileIcon path={file.path} className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* The name keeps its room; the path gives way first and is shortened from the start. */}
              <span className="flex min-w-0 items-baseline gap-1.5 text-xs">
                <span className="max-w-full shrink-0 truncate font-medium">{name}</span>
                {display === name ? null : (
                  <PathText path={display} className="text-muted-foreground flex-1 font-mono text-2xs" />
                )}
              </span>
              <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-2xs">
                {file.ops.map((op) => (
                  <Badge key={op} variant={OP_VARIANT[op]} data-op={op}>
                    {t(`files.ops.${op}`)}
                  </Badge>
                ))}
                <time dateTime={file.lastAt} className="ml-0.5">
                  {format.relative(file.lastAt, now)}
                </time>
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <FileActionItems actions={actions} kind="context" />
        </ContextMenuContent>
      </ContextMenu>
      <FileActionsMenu
        path={file.path}
        actions={actions}
        className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
      />
    </div>
  );
});

function byLastAtDesc(a: SessionFile, b: SessionFile): number {
  return Date.parse(b.lastAt) - Date.parse(a.lastAt);
}

export function FilesPanel({ sessionKey }: { sessionKey: string }) {
  const { t, tError } = useI18n();
  const cwd = useSummarySelector(sessionKey, (summary) => summary.cwd, null);
  const { files, truncated, error, loading, refresh } = useSessionFiles(sessionKey);
  const [query, setQuery] = useState('');
  const now = useNow(30_000);

  const rows = useMemo<Row[]>(
    () =>
      [...(files ?? [])]
        .sort(byLastAtDesc)
        .map((file) => ({ file, display: relativeToRoot(file.path, cwd) ?? file.path })),
    [files, cwd],
  );
  const visible = useMemo(
    () => fuzzyFilter(rows, query, (row) => [row.display, fileName(row.file.path)]),
    [rows, query],
  );

  return (
    <section
      data-slot="files-panel"
      aria-label={t('files.panel.title')}
      aria-busy={loading}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Input
          type="search"
          value={query}
          placeholder={t('files.panel.filter')}
          aria-label={t('files.panel.filter')}
          className="h-7 min-w-0 flex-1"
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        {files === null ? null : (
          <span className="text-muted-foreground shrink-0 text-2xs tabular-nums" data-slot="files-count">
            {t('files.panel.count', { count: visible.length })}
          </span>
        )}
      </div>
      {error === null ? null : (
        <div className="shrink-0 px-3 pt-3">
          <Alert
            tone="error"
            title={t('files.panel.error')}
            actions={
              <Button variant="outline" size="sm" onClick={refresh}>
                {t('files.viewer.retry')}
              </Button>
            }
          >
            {tError(error)}
          </Alert>
        </div>
      )}
      {truncated ? (
        <p
          className="text-muted-foreground shrink-0 border-b px-3 py-1.5 text-2xs"
          data-slot="files-truncated"
        >
          {t('files.panel.truncated')}
        </p>
      ) : null}
      {files !== null && rows.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm" data-slot="files-empty">
          {t('files.panel.empty')}
        </p>
      ) : null}
      {rows.length > 0 && visible.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm" data-slot="files-no-match">
          {t('files.panel.noMatch', { query: query.trim() })}
        </p>
      ) : null}
      {visible.length === 0 ? null : (
        <VList
          role="list"
          aria-label={t('files.panel.list')}
          data={visible}
          itemSize={FILES_ROW_HEIGHT}
          className="min-h-0 flex-1"
        >
          {(row) => <FileRow key={row.file.path} sessionKey={sessionKey} row={row} now={now} />}
        </VList>
      )}
    </section>
  );
}

export default FilesPanel;
