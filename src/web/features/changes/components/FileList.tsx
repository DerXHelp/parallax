import { ChevronRightIcon, ExternalLinkIcon, MessageSquareIcon } from 'lucide-react';
import { useId, useMemo } from 'react';
import type { GitDiffFile, GitDiffScope, ReviewComment } from '@shared/model';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { requestShell } from '@web/shell/requests';
import { useSessionPaths } from '@web/state/host-platform';
import { Checkbox } from '@web/ui/checkbox';
import { DIFF_MARKER } from '@web/ui/diff-view';
import { IconButton } from '@web/ui/icon-button';
import { isFileExpanded, setFileExpanded, setFileSelected, useChangesView } from '../state/view';
import { FileDiff } from './FileDiff';
import { StatusMark } from './StatusMark';

/**
 * The changed files of the scope (WP-113): status symbol, name and folder, +/− lines, comment count;
 * a click opens or closes the file's diff (loaded on demand). A checkbox picks a file for "Commit
 * selected" (only files with uncommitted changes), "Open" shows it in the viewer (request `openFile`).
 */

function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

function FileEntry({
  sessionKey,
  root,
  file,
  scope,
  generation,
  comments,
  expanded,
  committable,
  picked,
}: {
  sessionKey: string;
  root: string;
  file: GitDiffFile;
  scope: GitDiffScope;
  generation: number;
  comments: readonly ReviewComment[];
  expanded: boolean;
  committable: boolean;
  picked: boolean;
}) {
  const { t } = useI18n();
  const rules = useSessionPaths(sessionKey);
  const bodyId = useId();
  const { name, dir } = splitPath(file.path);
  const absolute = rules.resolve(root, file.path) ?? rules.join(root, file.path);
  return (
    <li data-slot="changes-file" data-path={file.path} data-kind={file.kind} className="border-b">
      <div className="hover:bg-muted/50 flex min-w-0 items-center gap-1.5 pr-1 pl-3">
        {committable ? (
          <Checkbox
            checked={picked}
            aria-label={t('changes.files.select', { name: file.path })}
            data-slot="changes-file-select"
            onCheckedChange={(checked) => {
              setFileSelected(sessionKey, file.path, checked === true);
            }}
          />
        ) : (
          <span aria-hidden className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          data-slot="changes-file-toggle"
          title={file.origPath === null ? file.path : t('changes.files.renamedFrom', { path: file.origPath })}
          className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
          onClick={() => {
            setFileExpanded(sessionKey, file.path, !expanded);
          }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              'text-muted-foreground size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
          <StatusMark kind={file.kind} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
            <span className="max-w-full shrink-0 truncate font-medium">{name}</span>
            {dir === '' ? null : (
              <span className="text-muted-foreground min-w-0 truncate font-mono text-2xs">{dir}</span>
            )}
          </span>
          {comments.length > 0 ? (
            <span
              className="text-warning flex shrink-0 items-center gap-0.5 text-2xs"
              data-slot="changes-file-comments"
            >
              <MessageSquareIcon aria-hidden className="size-3" />
              <span aria-hidden>{comments.length}</span>
              <span className="sr-only">{t('changes.files.comments', { count: comments.length })}</span>
            </span>
          ) : null}
          {file.binary ? null : (
            <span
              className="flex shrink-0 gap-1 font-mono text-2xs tabular-nums"
              data-slot="changes-file-stats"
            >
              <span aria-hidden className="text-success">
                {DIFF_MARKER.add}
                {file.additions}
              </span>
              <span aria-hidden className="text-destructive">
                {DIFF_MARKER.remove}
                {file.deletions}
              </span>
              <span className="sr-only">{t('changes.files.additions', { count: file.additions })}</span>
              <span className="sr-only">{t('changes.files.deletions', { count: file.deletions })}</span>
            </span>
          )}
        </button>
        {file.kind === 'deleted' ? null : (
          <IconButton
            label={t('changes.files.open', { name })}
            size="icon-xs"
            data-action="changes-open-file"
            onClick={() => {
              requestShell({ kind: 'openFile', sessionKey, path: absolute });
            }}
          >
            <ExternalLinkIcon aria-hidden />
          </IconButton>
        )}
      </div>
      {expanded ? (
        <div id={bodyId} className="border-t">
          <FileDiff
            sessionKey={sessionKey}
            file={file}
            scope={scope}
            generation={generation}
            comments={comments}
          />
        </div>
      ) : null}
    </li>
  );
}

export function FileList({
  sessionKey,
  root,
  files,
  scope,
  generation,
  comments,
  committable,
}: {
  sessionKey: string;
  root: string;
  files: readonly GitDiffFile[];
  scope: GitDiffScope;
  generation: number;
  comments: readonly ReviewComment[];
  /** Paths with uncommitted changes (`git.status` files) – only those can be picked for a commit. */
  committable: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const view = useChangesView(sessionKey);
  const byPath = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const comment of comments) map.set(comment.path, [...(map.get(comment.path) ?? []), comment]);
    return map;
  }, [comments]);
  return (
    <ul aria-label={t('changes.files.label')} data-slot="changes-files">
      {files.map((file) => (
        <FileEntry
          key={file.path}
          sessionKey={sessionKey}
          root={root}
          file={file}
          scope={scope}
          generation={generation}
          comments={byPath.get(file.path) ?? NO_COMMENTS}
          expanded={isFileExpanded(view, file.path, files.length)}
          committable={committable.has(file.path)}
          picked={view.selected.includes(file.path)}
        />
      ))}
    </ul>
  );
}

const NO_COMMENTS: readonly ReviewComment[] = Object.freeze([]);
