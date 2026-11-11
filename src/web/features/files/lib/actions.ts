import {
  AppWindowIcon,
  ClipboardCopyIcon,
  EyeIcon,
  FolderOpenIcon,
  SquarePenIcon,
  type LucideIcon,
} from 'lucide-react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import { isDefaultProgramAllowed, type FileKind, type FileOpenTarget } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import type { TranslationKey } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { requestShell } from '@web/shell/requests';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';

/**
 * Actions on a file (WP-54, ADR-144): viewer (shell request `openFile`), editor/Explorer/default
 * program (`file.open`, only on the local host – they start programs on the server's desktop),
 * copy path. Failures are hints (`showErrorNotice`, translated with tError by the notice region).
 * Every action refuses paths that fail the C.10 filter.
 */

export type FileActionId = 'viewer' | 'editor' | 'explorer' | 'default' | 'copy';

export interface FileTarget {
  sessionKey: string;
  path: string;
  line?: number | null;
  col?: number | null;
}

/** Programs may only be started on the machine of the local host (ADR-144). */
export function isLocalSession(sessionKey: string): boolean {
  return parseSessionKey(sessionKey)?.hostId === LOCAL_HOST_ID;
}

/** Shows the file in the viewer tab of the session's side panel; false when no host took it. */
export function openInViewer({ sessionKey, path, line = null, col = null }: FileTarget): boolean {
  if (windowsPathIssue(path) !== null) return false;
  return requestShell({ kind: 'openFile', sessionKey, path, line, col });
}

/** `file.open` (editor at line/column, Explorer with the file selected, default program). */
export async function openExternally(
  { sessionKey, path, line = null, col = null }: FileTarget,
  target: FileOpenTarget,
): Promise<boolean> {
  const entryId = parseSessionKey(sessionKey)?.entryId;
  if (entryId === undefined || windowsPathIssue(path) !== null || !isLocalSession(sessionKey)) return false;
  try {
    await sendCommand(sessionKey, {
      name: 'file.open',
      entryId,
      path,
      target,
      line: target === 'editor' ? line : null,
      col: target === 'editor' ? col : null,
    });
    return true;
  } catch (error) {
    showErrorNotice(errorPayloadOf(error), { sessionKey });
    return false;
  }
}

/** Copies the full path; confirms with a hint. */
export async function copyFilePath(path: string, sessionKey?: string): Promise<boolean> {
  const ok = await copyText(path);
  showTextNotice(ok ? 'files.notice.copied' : 'files.notice.copyFailed', undefined, {
    tone: ok ? 'success' : 'error',
    sessionKey: sessionKey ?? null,
  });
  return ok;
}

export interface FileAction {
  id: FileActionId;
  label: TranslationKey;
  icon: LucideIcon;
  run: () => void;
}

export interface FileActionOptions extends FileTarget {
  /** Known kind (stat); null = unknown (actions that need a file stay offered). */
  kind?: FileKind | null;
  /** Offer "Open in viewer" (not inside the viewer itself). */
  viewer?: boolean;
}

/**
 * The action list of a file for menus (FileLink, Files panel, viewer header): editor/Explorer/
 * default program only on the local host; the default program only for the allow-listed
 * extensions; editor and default program never for a folder.
 */
export function fileActions(options: FileActionOptions): FileAction[] {
  const { path, kind = null, viewer = true } = options;
  if (windowsPathIssue(path) !== null) return [];
  const local = isLocalSession(options.sessionKey);
  const folder = kind === 'directory';
  const actions: FileAction[] = [];
  if (viewer) {
    actions.push({
      id: 'viewer',
      label: 'files.actions.viewer',
      icon: EyeIcon,
      run: () => {
        openInViewer(options);
      },
    });
  }
  if (local && !folder) {
    actions.push({
      id: 'editor',
      label: 'files.actions.editor',
      icon: SquarePenIcon,
      run: () => {
        void openExternally(options, 'editor');
      },
    });
  }
  if (local) {
    actions.push({
      id: 'explorer',
      label: 'files.actions.explorer',
      icon: FolderOpenIcon,
      run: () => {
        void openExternally(options, 'explorer');
      },
    });
  }
  if (local && !folder && isDefaultProgramAllowed(path)) {
    actions.push({
      id: 'default',
      label: 'files.actions.default',
      icon: AppWindowIcon,
      run: () => {
        void openExternally(options, 'default');
      },
    });
  }
  actions.push({
    id: 'copy',
    label: 'files.actions.copyPath',
    icon: ClipboardCopyIcon,
    run: () => {
      void copyFilePath(path, options.sessionKey);
    },
  });
  return actions;
}

/**
 * Primary click on a reference: viewer; Ctrl/Cmd+click (or the middle button) opens the editor on
 * the local host – on a remote host it falls back to the viewer.
 */
export function activateFile(target: FileTarget, editor: boolean): void {
  if (editor && isLocalSession(target.sessionKey)) void openExternally(target, 'editor');
  else openInViewer(target);
}
