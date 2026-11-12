import {
  AppWindowIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ClipboardCopyIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  HistoryIcon,
  InfoIcon,
  MoonIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from 'lucide-react';
import { Fragment } from 'react';
import { LOCAL_HOST_ID, parseSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { SessionSummary } from '@shared/model';
import { windowsPathIssue } from '@shared/paths';
import type { Command } from '@shared/protocol';
import { useT, type TranslationKey } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { focusElement, focusedElement } from '@web/lib/return-focus';
import { openSessionWindow } from '@web/lib/windows';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from '@web/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@web/ui/dropdown-menu';
import { openNewSession } from '../NewSessionDialog';
import { requestShell } from '../requests';
import { shortcutKeyLabels } from '../shortcuts';
import { sessionFocusTarget } from './focus';
import { isHandoffPending, openExternalConsole } from './handoff';
import { startRenameAfterMenu, takePendingRename, type RenamePlace } from './rename';

/**
 * The actions of one session (WP-35 §3, §8): one definition for the sidebar context menu, the "…"
 * menu of a row and the header menu. The server decides (architecture §5.2, WP-30 §4.12); the UI
 * only disables what cannot work and shows refusals as notices (`showErrorNotice`).
 */
export type SessionActionId =
  | 'rename'
  | 'pin'
  | 'openWindow'
  | 'openFolder'
  | 'newSessionHere'
  | 'sleep'
  | 'openExternal'
  | 'copyConsoleCommand'
  | 'archive'
  | 'conversations'
  | 'sessionInfo';

export type SessionActionSlot = SessionActionId | 'separator';

export interface SessionAction {
  id: SessionActionId;
  label: TranslationKey;
  icon: LucideIcon;
  /** Shortcut hint shown in the menu (registry syntax, e.g. `F2`). */
  shortcut?: string;
  disabled: boolean;
  run: () => void;
}

/** Sidebar context menu and the "…" menu of a row (order of WP-35 §3; WP-58: + open folder). */
export const SIDEBAR_ACTIONS: readonly SessionActionSlot[] = [
  'rename',
  'pin',
  'openWindow',
  'openFolder',
  'newSessionHere',
  'separator',
  'sleep',
  'openExternal',
  'copyConsoleCommand',
  'separator',
  'archive',
];

/** Header menu (WP-35 §8; WP-58: + open folder). */
export const HEADER_ACTIONS: readonly SessionActionSlot[] = [
  'conversations',
  'sessionInfo',
  'rename',
  'separator',
  'openWindow',
  'openFolder',
  'openExternal',
  'copyConsoleCommand',
  'separator',
  'sleep',
  'archive',
];

/** Fire-and-forget command of a menu action; a refusal becomes a notice of that session. */
export function runSessionCommand(sessionKey: string, cmd: Command): void {
  sendCommand(sessionKey, cmd).catch((error: unknown) => {
    showErrorNotice(errorPayloadOf(error), { sessionKey });
  });
}

/** "Copy console command" (ADR-104): the PowerShell line to the clipboard + the two-writers warning. */
export function copyConsoleCommand(sessionKey: string, summary: SessionSummary): void {
  sendCommand(sessionKey, { name: 'session.consoleCommand', entryId: summary.entryId })
    .then(async (result) => {
      const copied = await copyText(result.command);
      if (copied) {
        showTextNotice('navigation.console.copied', undefined, {
          tone: 'warning',
          id: 'navigation-console',
          durationMs: 15_000,
        });
      } else {
        showTextNotice('navigation.console.copyFailed', undefined, {
          tone: 'error',
          id: 'navigation-console',
        });
      }
    })
    .catch((error: unknown) => {
      showErrorNotice(errorPayloadOf(error), { sessionKey });
    });
}

/**
 * "New session in this project…": the dialog of WP-36 pre-filled. `openNewSession` asks the
 * request channel itself and, without a mounted dialog, keeps the folder for its next opening
 * (WP-40: the former fallback `openNewSession()` lost the folder).
 */
export function newSessionIn(cwd: string): void {
  openNewSession({ cwd });
}

/**
 * "Open folder in Explorer" (WP-58, ADR-144): `file.open {target: 'explorer', path: cwd}` – the
 * `cwd` string exactly as stored; the server checks the path and starts Explorer (only on the local
 * host). A refusal (`OPEN_FAILED`, `PATH_NOT_ALLOWED`, `FILE_NOT_FOUND` …) becomes a notice.
 * Defence in depth (R5W-10, C.10): a `cwd` that `windowsPathIssue` rejects (UNC, device, ADS …) is
 * never sent – the same notice as the server's refusal instead.
 */
export function openFolderInExplorer(sessionKey: string, summary: SessionSummary): void {
  if (windowsPathIssue(summary.cwd) !== null) {
    showErrorNotice(makeError('PATH_REJECTED'), { sessionKey });
    return;
  }
  runSessionCommand(sessionKey, {
    name: 'file.open',
    entryId: summary.entryId,
    path: summary.cwd,
    target: 'explorer',
    line: null,
    col: null,
  });
}

/** True for a session of the local host (Explorer, new window: only there). */
export function isLocalSession(sessionKey: string): boolean {
  return parseSessionKey(sessionKey)?.hostId === LOCAL_HOST_ID;
}

/** An action queued by a menu item for the moment its menu has closed (see sessionMenuCloseAutoFocus). */
let afterMenu: { sessionKey: string; action: () => void } | null = null;

/**
 * Runs `action` once the session's menu has closed and the focus is back on its "…" (header) or
 * row (sidebar) – for actions that move the focus themselves (opening the side panel: its opener
 * must be the "…" button, not the menu item that is gone by then). Only the next close of a menu
 * of the same session runs it; any other close drops it.
 */
export function runAfterMenu(sessionKey: string, action: () => void): void {
  afterMenu = { sessionKey, action };
}

/** A process runs (the only states where "Put to sleep" = `session.close` means anything). */
export function hasProcess(summary: SessionSummary): boolean {
  const { runState } = summary.status;
  return runState === 'idle' || runState === 'working' || runState === 'starting';
}

function build(
  id: SessionActionId,
  sessionKey: string,
  summary: SessionSummary,
  place: RenamePlace,
): SessionAction | null {
  const entryId = summary.entryId;
  const external = summary.external !== null;
  const started = summary.sessionId !== null;
  switch (id) {
    case 'rename':
      return {
        id,
        label: 'navigation.actions.rename',
        icon: PencilIcon,
        shortcut: 'F2',
        disabled: false,
        // Menus only: the field opens once the menu has closed (rename.ts).
        run: () => {
          startRenameAfterMenu(sessionKey, place);
        },
      };
    case 'pin':
      return {
        id,
        label: summary.pinned ? 'navigation.actions.unpin' : 'navigation.actions.pin',
        icon: summary.pinned ? PinOffIcon : PinIcon,
        disabled: false,
        run: () => {
          runSessionCommand(sessionKey, { name: 'session.setPinned', entryId, pinned: !summary.pinned });
        },
      };
    case 'openWindow':
      return {
        id,
        label: 'navigation.actions.openWindow',
        icon: AppWindowIcon,
        // `#session=<entryId>` addresses the local host (state/selection.ts).
        disabled: !isLocalSession(sessionKey),
        run: () => {
          openSessionWindow(entryId);
        },
      };
    case 'openFolder':
      // Explorer would open on the host's machine: only for the local host (ADR-144).
      if (!isLocalSession(sessionKey)) return null;
      return {
        id,
        label: 'navigation.actions.openFolder',
        icon: FolderOpenIcon,
        disabled: false,
        run: () => {
          openFolderInExplorer(sessionKey, summary);
        },
      };
    case 'newSessionHere':
      return {
        id,
        label: 'navigation.actions.newSessionHere',
        icon: FolderPlusIcon,
        disabled: false,
        run: () => {
          newSessionIn(summary.cwd);
        },
      };
    case 'sleep':
      if (!hasProcess(summary)) return null;
      return {
        id,
        label: 'navigation.actions.sleep',
        icon: MoonIcon,
        // Never ends a running turn by accident: only an idle process.
        disabled: summary.status.runState !== 'idle',
        run: () => {
          runSessionCommand(sessionKey, { name: 'session.close', entryId });
        },
      };
    case 'openExternal':
      return {
        id,
        label: 'navigation.actions.openExternal',
        icon: SquareTerminalIcon,
        disabled: !started || external || summary.archived || isHandoffPending(sessionKey),
        run: () => {
          // WP41-07: tracked – the composer sends nothing until the server answered.
          openExternalConsole(sessionKey, entryId).catch((error: unknown) => {
            showErrorNotice(errorPayloadOf(error), { sessionKey });
          });
        },
      };
    case 'copyConsoleCommand':
      return {
        id,
        label: 'navigation.actions.copyConsoleCommand',
        icon: ClipboardCopyIcon,
        disabled: !started,
        run: () => {
          copyConsoleCommand(sessionKey, summary);
        },
      };
    case 'archive':
      return {
        id,
        label: summary.archived ? 'navigation.actions.restore' : 'navigation.actions.archive',
        icon: summary.archived ? ArchiveRestoreIcon : ArchiveIcon,
        disabled: external,
        run: () => {
          runSessionCommand(sessionKey, {
            name: 'session.setArchived',
            entryId,
            archived: !summary.archived,
          });
        },
      };
    case 'conversations':
      return {
        id,
        label: 'navigation.actions.conversations',
        icon: HistoryIcon,
        disabled: false,
        run: () => {
          requestShell({ kind: 'conversations', sessionKey });
        },
      };
    case 'sessionInfo':
      return {
        id,
        label: 'navigation.actions.sessionInfo',
        icon: InfoIcon,
        disabled: false,
        run: () => {
          requestShell({ kind: 'sessionInfo', sessionKey });
        },
      };
  }
}

/** The actions of `slots` for this session; `null` = separator (never leading, trailing or doubled). */
export function sessionActions(
  slots: readonly SessionActionSlot[],
  sessionKey: string,
  summary: SessionSummary,
  place: RenamePlace,
): (SessionAction | null)[] {
  const result: (SessionAction | null)[] = [];
  for (const slot of slots) {
    if (slot === 'separator') {
      if (result.length > 0 && result.at(-1) !== null) result.push(null);
      continue;
    }
    const action = build(slot, sessionKey, summary, place);
    if (action !== null) result.push(action);
  }
  if (result.at(-1) === null) result.pop();
  return result;
}

/**
 * `onCloseAutoFocus` of every menu with session actions (`place`: where the menu belongs):
 * - a chosen "Rename" opens its field now and keeps the focus there (instead of Radix returning it
 *   to the menu trigger);
 * - an action queued with `runAfterMenu` runs now, after the focus went back to the session's "…"
 *   (header) or row (sidebar) – e.g. opening the side panel, which then returns the focus there;
 * - otherwise Radix returns the focus to the trigger – but the row's "…" exists only on hover or
 *   focus, and a pinned row has moved meanwhile: if the focus ended on `<body>`, it goes to the
 *   session's row (sidebar) or the header's "…" (V3-04 "Anheften"). A dialog the action opened
 *   keeps it.
 */
export function sessionMenuCloseAutoFocus(sessionKey: string, place: RenamePlace): (event: Event) => void {
  return (event) => {
    if (takePendingRename()) {
      event.preventDefault();
      return;
    }
    const queued = afterMenu;
    afterMenu = null;
    if (queued?.sessionKey === sessionKey) {
      event.preventDefault();
      focusElement(sessionFocusTarget(sessionKey, place));
      queued.action();
      return;
    }
    // After Radix' own attempt (same task) and React's re-render of a moved row.
    setTimeout(() => {
      if (focusedElement() === null) focusElement(sessionFocusTarget(sessionKey, place));
    }, 0);
  };
}

/** Menu items of the actions, as context-menu or dropdown-menu items. */
export function SessionActionItems({
  actions,
  kind,
}: {
  actions: readonly (SessionAction | null)[];
  kind: 'context' | 'dropdown';
}) {
  const t = useT();
  return (
    <>
      {actions.map((action, index) => {
        if (action === null) {
          return kind === 'context' ? (
            <ContextMenuSeparator key={`separator-${String(index)}`} />
          ) : (
            <DropdownMenuSeparator key={`separator-${String(index)}`} />
          );
        }
        const Icon = action.icon;
        const shortcut =
          action.shortcut === undefined ? null : shortcutKeyLabels(action.shortcut, t).join('+');
        const content = (
          <>
            <Icon aria-hidden />
            {t(action.label)}
            {shortcut === null ? null : kind === 'context' ? (
              <ContextMenuShortcut>{shortcut}</ContextMenuShortcut>
            ) : (
              <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>
            )}
          </>
        );
        return (
          <Fragment key={action.id}>
            {kind === 'context' ? (
              <ContextMenuItem data-action={action.id} disabled={action.disabled} onSelect={action.run}>
                {content}
              </ContextMenuItem>
            ) : (
              <DropdownMenuItem data-action={action.id} disabled={action.disabled} onSelect={action.run}>
                {content}
              </DropdownMenuItem>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
