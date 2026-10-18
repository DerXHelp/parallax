import {
  AppWindowIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ClipboardCopyIcon,
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
import type { SessionSummary } from '@shared/model';
import type { Command } from '@shared/protocol';
import { useT, type TranslationKey } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { openSessionWindow } from '@web/lib/windows';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { showErrorNotice, showTextNotice } from '@web/state/notices';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from '@web/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from '@web/ui/dropdown-menu';
import { openNewSession } from '../NewSessionDialog';
import { requestShell } from '../requests';
import { shortcutKeyLabels } from '../shortcuts';
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

/** Sidebar context menu and the "…" menu of a row (order of WP-35 §3). */
export const SIDEBAR_ACTIONS: readonly SessionActionSlot[] = [
  'rename',
  'pin',
  'openWindow',
  'newSessionHere',
  'separator',
  'sleep',
  'openExternal',
  'copyConsoleCommand',
  'separator',
  'archive',
];

/** Header menu (WP-35 §8). */
export const HEADER_ACTIONS: readonly SessionActionSlot[] = [
  'conversations',
  'sessionInfo',
  'rename',
  'separator',
  'openWindow',
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
        disabled: parseSessionKey(sessionKey)?.hostId !== LOCAL_HOST_ID,
        run: () => {
          openSessionWindow(entryId);
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
        disabled: !started || external || summary.archived,
        run: () => {
          runSessionCommand(sessionKey, { name: 'session.openExternal', entryId });
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
 * `onCloseAutoFocus` of every menu with session actions: a chosen "Rename" opens its field now and
 * keeps the focus there (instead of Radix returning it to the menu trigger).
 */
export function onSessionMenuCloseAutoFocus(event: Event): void {
  if (takePendingRename()) event.preventDefault();
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
