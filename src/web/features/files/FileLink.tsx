import { memo, type MouseEvent } from 'react';
import type { FileKind } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import { useT } from '@web/i18n';
import { pathTail } from '@web/lib/path-display';
import type { FileLinkSlotProps } from '@web/shell/slots';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@web/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/ui/tooltip';
import { FileActionItems, FileActionsMenu } from './components/FileActionItems';
import { FileIcon } from './components/FileIcon';
import { defaultFileLinkLabel, PlainReference, type FileLinkState } from './components/PlainReference';
import { activateFile, fileActions, type FileTarget } from './lib/actions';
import { fileName } from './lib/paths';
import { useFileStat, type StatEntry } from './state/stat-cache';

/**
 * Slot `FileLink` (WP-54, ADR-141/144, L15): a file reference with actions. A path that fails the
 * C.10 filter (`windowsPathIssue`: UNC, device, ADS …) stays plain text and never causes a command.
 * With `verify` the reference becomes a link only after `file.statMany` answered `ok: true`
 * (batching cache, state/stat-cache.ts); a refused path (`PATH_NOT_ALLOWED`) says so in a tooltip.
 * Click → viewer (shell request `openFile`), Ctrl/Cmd+click or middle click → editor (local host),
 * right click → the actions (lib/actions.ts). The slot in index.ts loads this module lazily and
 * shows the plain text (components/PlainReference.tsx) meanwhile.
 */

function linkState(safe: boolean, verify: boolean, entry: StatEntry | undefined): FileLinkState {
  if (!safe) return 'unsafe';
  if (!verify) return 'link';
  const result = entry?.result ?? null;
  if (result === null) return 'checking';
  if (result.ok) return 'link';
  return result.error.code === 'PATH_NOT_ALLOWED' ? 'refused' : 'missing';
}

const linkClasses: Readonly<Record<'inline' | 'chip', string>> = {
  // `text-link`: >= 4.5:1 also inside inline code (muted background), V4-04.
  inline:
    'text-link decoration-link/40 hover:decoration-link focus-visible:ring-ring cursor-pointer break-all rounded-sm text-left underline underline-offset-2 outline-none focus-visible:ring-2',
  chip: 'bg-muted/60 hover:bg-muted focus-visible:ring-ring inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border px-1.5 align-middle text-xs outline-none focus-visible:ring-2',
};

export const FileLink = memo(function FileLink({
  sessionKey,
  path,
  line = null,
  col = null,
  verify = false,
  variant = 'inline',
  children,
}: FileLinkSlotProps) {
  const t = useT();
  const safe = windowsPathIssue(path) === null;
  const entry = useFileStat(sessionKey, safe && verify ? path : null);
  const state = linkState(safe, verify, entry);
  const label = children ?? defaultFileLinkLabel(path, line);

  if (state !== 'link') {
    if (variant === 'menu') return null;
    return (
      <PlainReference
        state={state}
        label={label}
        tooltip={state === 'refused' ? t('files.link.notAllowed') : null}
      />
    );
  }

  const result = entry?.result;
  const kind: FileKind | null = result?.ok === true ? result.file.kind : null;
  const target: FileTarget = { sessionKey, path, line, col };
  const actions = fileActions({ ...target, kind });
  if (variant === 'menu') return <FileActionsMenu path={path} actions={actions} />;

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    activateFile(target, event.ctrlKey || event.metaKey);
  };
  const onAuxClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    activateFile(target, true);
  };
  const onMouseDown = (event: MouseEvent) => {
    // No auto-scroll cursor on a middle click (it opens the editor instead).
    if (event.button === 1) event.preventDefault();
  };
  const tooltip = line === null ? path : t('files.link.tooltip', { path, line });

  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-slot="file-link"
              data-state="link"
              data-variant={variant}
              data-kind={kind ?? undefined}
              className={linkClasses[variant]}
              onClick={onClick}
              onAuxClick={onAuxClick}
              onMouseDown={onMouseDown}
            >
              {variant === 'chip' ? (
                <>
                  <FileIcon path={path} kind={kind} className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="shrink-0 font-medium">{children ?? fileName(path)}</span>
                  <span className="text-muted-foreground min-w-0 truncate font-mono text-2xs">
                    {pathTail(path, 3)}
                  </span>
                </>
              ) : (
                label
              )}
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent className="font-mono break-all">{tooltip}</TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <FileActionItems actions={actions} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  );
});

export default FileLink;
