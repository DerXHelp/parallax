import { RefreshCwIcon } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { LIMITS } from '@shared/common';
import type { FileInfo } from '@shared/model';
import { windowsPathKey } from '@shared/paths';
import { useI18n } from '@web/i18n';
import { formatFileSize } from '@web/lib/bytes';
import { cn } from '@web/lib/cn';
import { languageForPath } from '@web/lib/languages';
import { useFeatureSlots, type FilePanelSlotProps } from '@web/shell/slots';
import { useNow } from '@web/state/clock';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { IconButton } from '@web/ui/icon-button';
import { Skeleton } from '@web/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { FileIcon } from './components/FileIcon';
import { ImageView } from './components/ImageView';
import { PathText } from './components/PathText';
import { fileActions, openExternally, type FileAction } from './lib/actions';
import { fileName, parentPath } from './lib/paths';
import { useFileDocument, type FileDocumentHandle } from './state/file-document';

/** Code view and PDF frame are chunks of their own (WP-54 §7). */
const CodeView = lazy(() => import('./components/CodeView'));
const PdfView = lazy(() => import('./components/PdfView'));

type MarkdownMode = 'rendered' | 'source';

/**
 * Slot `FilePanel` (WP-54, ADR-142/143): the viewer of one file in the tab "File" of the side panel –
 * header (name, folder shortened from the start with the full path as tooltip, kind, size in decimal
 * units like everywhere (`@web/lib/bytes`), modified, "Last known state" when a later check failed;
 * refresh, editor, Explorer, default program, copy path; Markdown rendered/source), then the content
 * by kind: Markdown through the slot `Markdown` (relative links against the file's folder), text/code
 * in the virtualized code view (line jump, column mark), image, PDF; binary files and folders get the
 * actions only. Read-only (F2). Live: see state/file-document.ts. Mounted per path (`key`).
 */
export function FilePanel(props: FilePanelSlotProps) {
  return <FileViewer key={windowsPathKey(props.path)} {...props} />;
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2 p-4">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-5/6" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

function ActionButtons({ actions }: { actions: readonly FileAction[] }) {
  const { t } = useI18n();
  return actions.map((action) => {
    const Icon = action.icon;
    return (
      <Button key={action.id} variant="outline" size="sm" data-action={action.id} onClick={action.run}>
        <Icon aria-hidden />
        {t(action.label)}
      </Button>
    );
  });
}

function Header({
  path,
  info,
  doc,
  actions,
  mode,
  onModeChange,
}: {
  path: string;
  info: FileInfo | null;
  doc: FileDocumentHandle;
  actions: readonly FileAction[];
  mode: MarkdownMode;
  onModeChange: (mode: MarkdownMode) => void;
}) {
  const { t, format } = useI18n();
  const now = useNow(30_000);
  const folder = parentPath(path);
  return (
    <div data-slot="file-panel-header" className="flex shrink-0 flex-col gap-1 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <FileIcon path={path} kind={info?.kind ?? null} className="text-muted-foreground size-4 shrink-0" />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The name keeps its room; the folder gives way first and is shortened from the start. */}
            <h2
              tabIndex={0}
              className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm outline-none"
              data-slot="file-panel-title"
            >
              <span className="max-w-full shrink-0 truncate font-medium">{fileName(path)}</span>
              {folder === '' ? null : (
                <PathText path={folder} className="text-muted-foreground flex-1 font-mono text-2xs" />
              )}
            </h2>
          </TooltipTrigger>
          <TooltipContent className="font-mono break-all">{path}</TooltipContent>
        </Tooltip>
        <IconButton
          label={t('files.actions.refresh')}
          data-action="refresh"
          onClick={doc.refresh}
          aria-busy={doc.busy}
        >
          <RefreshCwIcon aria-hidden className={cn(doc.busy && 'motion-safe:animate-spin')} />
        </IconButton>
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <IconButton key={action.id} label={t(action.label)} data-action={action.id} onClick={action.run}>
              <Icon aria-hidden />
            </IconButton>
          );
        })}
      </div>
      {info === null ? null : (
        <div
          className="text-muted-foreground flex min-h-6 flex-wrap items-center gap-x-1.5 text-xs"
          data-slot="file-panel-meta"
        >
          {doc.stale ? (
            <Badge variant="warning" data-slot="file-panel-stale">
              {t('files.viewer.stale')}
            </Badge>
          ) : null}
          <span>{t(`files.kind.${info.kind}`)}</span>
          {info.kind === 'directory' ? null : (
            <>
              <span aria-hidden>·</span>
              <span>{formatFileSize(info.bytes, format)}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <time dateTime={new Date(info.mtimeMs).toISOString()} title={format.dateTime(info.mtimeMs)}>
            {t('files.viewer.modified', { time: format.relative(info.mtimeMs, now) })}
          </time>
          {info.kind === 'markdown' && info.previewable ? (
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={mode}
              aria-label={t('files.viewer.view')}
              className="ml-auto"
              onValueChange={(value) => {
                if (value === 'rendered' || value === 'source') onModeChange(value);
              }}
            >
              <ToggleGroupItem value="rendered" className="flex-none px-2">
                {t('files.viewer.rendered')}
              </ToggleGroupItem>
              <ToggleGroupItem value="source" className="flex-none px-2">
                {t('files.viewer.source')}
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Content({
  sessionKey,
  path,
  line,
  col,
  doc,
  info,
  mode,
  actions,
}: {
  sessionKey: string;
  path: string;
  line: number | null;
  col: number | null;
  doc: FileDocumentHandle;
  info: FileInfo;
  mode: MarkdownMode;
  actions: readonly FileAction[];
}) {
  const { t } = useI18n();
  const { Markdown } = useFeatureSlots();
  const name = fileName(path);
  const loading = <LoadingRows label={t('files.viewer.loading')} />;

  if (info.kind === 'directory' || info.kind === 'binary' || !info.previewable) {
    return (
      <div data-slot="file-no-preview" className="flex flex-col items-start gap-3 p-4 text-sm">
        <p className="text-muted-foreground">
          {info.kind === 'directory' ? t('files.viewer.folder') : t('files.viewer.noPreview')}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <ActionButtons actions={actions} />
        </div>
      </div>
    );
  }
  if (info.kind === 'image') {
    return doc.url === null ? null : <ImageView src={doc.url} name={name} version={doc.version} />;
  }
  if (info.kind === 'pdf') {
    if (doc.url === null) return null;
    const local = actions.some((action) => action.id === 'default');
    return (
      <Suspense fallback={loading}>
        <PdfView
          src={doc.url}
          name={name}
          version={doc.version}
          onOpenDefault={local ? () => void openExternally({ sessionKey, path }, 'default') : null}
        />
      </Suspense>
    );
  }
  if (doc.text === null) return doc.error === null ? loading : null;
  if (info.kind === 'markdown' && mode === 'rendered') {
    return (
      <div data-slot="markdown-view" className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <Markdown text={doc.text} sessionKey={sessionKey} baseDir={parentPath(path)} />
      </div>
    );
  }
  return (
    <Suspense fallback={loading}>
      <CodeView
        text={doc.text}
        language={info.kind === 'markdown' ? 'markdown' : languageForPath(path)}
        line={line}
        col={col}
        label={t('files.viewer.code', { name })}
      />
    </Suspense>
  );
}

function FileViewer({ sessionKey, path, line, col }: FilePanelSlotProps) {
  const { t, tError, format } = useI18n();
  const doc = useFileDocument(sessionKey, path);
  // A line to jump to is a line of the source: Markdown opens as source then.
  const [mode, setMode] = useState<MarkdownMode>(line === null ? 'rendered' : 'source');
  const info = doc.info;
  const headerActions = fileActions({ sessionKey, path, line, col, kind: info?.kind ?? null, viewer: false });

  return (
    <section
      data-slot="file-panel"
      data-kind={info?.kind}
      data-stale={doc.stale ? 'true' : undefined}
      aria-label={t('files.viewer.label')}
      aria-busy={doc.loading || doc.busy}
      className="flex min-h-0 flex-1 flex-col"
    >
      <Header path={path} info={info} doc={doc} actions={headerActions} mode={mode} onModeChange={setMode} />
      {doc.error === null ? null : (
        <div className="shrink-0 px-3 pt-3">
          <Alert
            tone="error"
            title={t('files.viewer.error')}
            actions={
              <Button variant="outline" size="sm" onClick={doc.refresh}>
                {t('files.viewer.retry')}
              </Button>
            }
          >
            {tError(doc.error)}
          </Alert>
        </div>
      )}
      {info?.truncated === true && doc.text !== null ? (
        <div className="shrink-0 px-3 pt-3" data-slot="file-truncated">
          <Alert tone="warning">
            {t('files.viewer.truncated', { size: formatFileSize(LIMITS.fileTextBytes, format) })}
          </Alert>
        </div>
      ) : null}
      {info === null ? (
        doc.loading ? (
          <LoadingRows label={t('files.viewer.loading')} />
        ) : null
      ) : (
        <Content
          sessionKey={sessionKey}
          path={path}
          line={line}
          col={col}
          doc={doc}
          info={info}
          mode={mode}
          actions={headerActions}
        />
      )}
    </section>
  );
}

export default FilePanel;
