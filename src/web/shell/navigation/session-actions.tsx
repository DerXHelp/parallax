import {
  AppWindowIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ClipboardCopyIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LinkIcon,
  FolderPlusIcon,
  MailDotIcon,
  MailOpenIcon,
  MessageCircleQuestionIcon,
  MessageSquareTextIcon,
  HistoryIcon,
  InfoIcon,
  ListXIcon,
  LogInIcon,
  MoonIcon,
  PanelRightOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SmartphoneIcon,
  SparklesIcon,
  SquareChevronRightIcon,
  SquareTerminalIcon,
  TerminalIcon,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { LOCAL_HOST_ID, parseSessionKey, type EntryId, type HostId, type TerminalId } from '@shared/common';
import { makeError } from '@shared/errors';
import { shellKindSchema, type SessionSummary, type ShellKind } from '@shared/model';
import type { Command, CommandName } from '@shared/protocol';
import { t as translateNow, useT, type TranslationKey } from '@web/i18n';
import { copyText } from '@web/lib/clipboard';
import { focusElement, focusedElement } from '@web/lib/return-focus';
import { effectiveShell, shellChoices } from '@web/lib/shells';
import { openClaudeSessionUrl, openSessionWindow } from '@web/lib/windows';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { getSessionCapabilities, getSessionPaths, selectHostFlavor } from '@web/state/host-platform';
import {
  canSendTo,
  selectSessionFeature,
  selectTerminalAvailable,
  sendHostCommand,
  sessionAllows,
} from '@web/state/hosts';
import { showErrorNotice, showTextNotice } from '@web/state/notices';
import { selectSettings } from '@web/state/settings';
import { clientStore } from '@web/state/store';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@web/ui/context-menu';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@web/ui/dropdown-menu';
import { openNewSession } from '../NewSessionDialog';
import { requestShell } from '../requests';
import { openSidePanel } from '../side-panel/state';
import { shortcutKeyLabels } from '../shortcuts';
import { sessionFocusTarget } from './focus';
import { isHandoffPending, openExternalConsole, trackHandoff } from './handoff';
import { openQuickAsk } from './quick-ask';
import { copyRemoteLink, remoteLinkOf } from './remote-control';
import { requestRemoveSession } from './remove-session';
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
  | 'sessionInfo'
  /** WP-63 §1.3: remove from Parallax only (confirmation dialog; files stay). */
  | 'remove'
  /** WP-64: Remote Control on/off, open the claude.ai link, copy it. */
  | 'remoteControl'
  | 'openRemote'
  | 'copyRemoteLink'
  /** WP-65 §1.3: a new AI title from the conversation (also over an own title – asked for). */
  | 'regenerateTitle'
  /** WP-66: "Quick question…" – a side question in a popover at the row. */
  | 'quickAsk'
  /** WP-70: sign in the profile (only while Remote Control failed for the sign-in). */
  | 'signIn'
  /** WP-70: the output style of the project (small dialog). */
  | 'outputStyle'
  /** WP-97: cmd, PowerShell or Git Bash as a window in the session's folder (submenu). */
  | 'openShell'
  | 'openTerminal'
  /**
   * WP-105 (102e): "Continue in terminal" – `claude --resume` in the embedded terminal of the session's
   * computer; while it runs there (`summary.external.terminalId`) "Show terminal with claude".
   */
  | 'openInTerminal'
  /** WP-115 (F6): "Mark as unread" / "Mark as read" (`session.setUnread`, host `features.overview`). */
  | 'unread';

export type SessionActionSlot = SessionActionId | 'separator';

export interface SessionAction {
  id: SessionActionId;
  label: TranslationKey;
  icon: LucideIcon;
  /** Shortcut hint shown in the menu (registry syntax, e.g. `F2`). */
  shortcut?: string;
  disabled: boolean;
  run: () => void;
  /** WP-97: a submenu instead of one item (the action's own `run` opens the default choice). */
  children?: readonly SessionSubAction[];
}

/** One item of a submenu (WP-97: the shells of "Open shell in folder"). */
export interface SessionSubAction {
  id: string;
  label: TranslationKey;
  /** A quiet note after the label (e.g. "Default"). */
  badge?: TranslationKey;
  shortcut?: string;
  disabled: boolean;
  run: () => void;
}

/**
 * Sidebar context menu and the "…" menu of a row (order of WP-35 §3; WP-58: + open folder; WP-63:
 * + remove; WP-64: + Remote Control; WP-65: + generate title again; WP-66: + quick question; WP-105:
 * + continue in terminal; WP-115: + mark as unread/read after "Pin").
 */
export const SIDEBAR_ACTIONS: readonly SessionActionSlot[] = [
  'quickAsk',
  'separator',
  'rename',
  'regenerateTitle',
  'pin',
  'unread',
  'openWindow',
  'openFolder',
  'openShell',
  'openTerminal',
  'newSessionHere',
  'separator',
  'sleep',
  'openExternal',
  'openInTerminal',
  'copyConsoleCommand',
  'separator',
  'signIn',
  'remoteControl',
  'openRemote',
  'copyRemoteLink',
  'separator',
  'archive',
  'remove',
];

/**
 * Header menu (WP-35 §8; WP-58: + open folder; WP-63: + remove; WP-64: + Remote Control; WP-65: + title;
 * WP-70: + output style, sign in; WP-105: + continue in terminal; WP-115: + mark as unread before
 * "Put to sleep" – "come back to this later").
 */
export const HEADER_ACTIONS: readonly SessionActionSlot[] = [
  'conversations',
  'sessionInfo',
  'outputStyle',
  'rename',
  'regenerateTitle',
  'separator',
  'openWindow',
  'openFolder',
  'openShell',
  'openTerminal',
  'openExternal',
  'openInTerminal',
  'copyConsoleCommand',
  'separator',
  'signIn',
  'remoteControl',
  'openRemote',
  'copyRemoteLink',
  'separator',
  'unread',
  'sleep',
  'archive',
  'remove',
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
 * (WP-40: the former fallback `openNewSession()` lost the folder). WP-80: on the folder's computer
 * (`hostId`, default this computer).
 */
export function newSessionIn(cwd: string, hostId: HostId = LOCAL_HOST_ID): void {
  openNewSession(hostId === LOCAL_HOST_ID ? { cwd } : { cwd, hostId });
}

/**
 * "Open folder in Explorer" (WP-58, ADR-144): `file.open {target: 'explorer', path: cwd}` – the
 * `cwd` string exactly as stored; the server checks the path and starts Explorer (only on the local
 * host). A refusal (`OPEN_FAILED`, `PATH_NOT_ALLOWED`, `FILE_NOT_FOUND` …) becomes a notice.
 * Defence in depth (R5W-10, C.10): a `cwd` that the rules of the session's host reject (Windows: UNC,
 * device, ADS …; Linux: relative, `/proc` … – WP-104) is never sent – the same notice as the server's
 * refusal instead. WP-104: on Linux the file manager of the desktop (`capabilities.fileManager`).
 */
export function openFolderInExplorer(sessionKey: string, summary: SessionSummary): void {
  if (getSessionPaths(sessionKey).issue(summary.cwd) !== null) {
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

/** WP-97: "Open shell in folder" with the default shell (help `?`, menu hint). */
export const OPEN_SHELL_KEYS = 'Alt+K';

/** Menu text of each shell (WP-97). */
export const SHELL_LABELS: Readonly<Record<ShellKind, TranslationKey>> = {
  cmd: 'navigation.shells.cmd',
  powershell: 'navigation.shells.powershell',
  gitbash: 'navigation.shells.gitbash',
  login: 'navigation.shells.login',
  bash: 'navigation.shells.bash',
  zsh: 'navigation.shells.zsh',
  fish: 'navigation.shells.fish',
  pwsh: 'navigation.shells.pwsh',
};

// ---- Shells of a host (WP-105: `shell.detect` of a Linux host, cached per host) ----

/** A detection answer is used this long before the next menu or panel asks again. */
export const SHELL_DETECT_TTL_MS = 60_000;
/** After a failed detection the next attempt waits this long (the kinds of the platform meanwhile). */
const SHELL_DETECT_RETRY_MS = 10_000;

interface HostShells {
  /** `shell.detect.shells`; null = not known (the detection failed). */
  shells: readonly ShellKind[] | null;
  /** When the answer (or the failure) arrived (`Date.now()`). */
  at: number;
}

const hostShellStore = createStore<{ byHost: Readonly<Partial<Record<HostId, HostShells>>> }>(() => ({
  byHost: {},
}));
const detecting = new Set<HostId>();

function hostOfSession(sessionKey: string | null): HostId {
  if (sessionKey === null) return LOCAL_HOST_ID;
  return parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID;
}

/**
 * Asks a Linux host which shells it has (`shell.detect`, also over remote access – E3). A Windows host
 * always offers its three (its detection would only look for Git again), so it is never asked; a fresh
 * answer is reused for `SHELL_DETECT_TTL_MS`, one request per host at a time, failures stay quiet (the
 * menus keep the kinds of the platform).
 */
export function detectHostShells(hostId: HostId): void {
  if (selectHostFlavor(clientStore.getState(), hostId) !== 'posix') return;
  if (detecting.has(hostId) || !canSendTo(hostId, 'shell.detect')) return;
  const known = hostShellStore.getState().byHost[hostId];
  const ttl = known?.shells === null ? SHELL_DETECT_RETRY_MS : SHELL_DETECT_TTL_MS;
  if (known !== undefined && Date.now() - known.at < ttl) return;
  detecting.add(hostId);
  const store = (shells: readonly ShellKind[] | null) => {
    hostShellStore.setState((state) => ({
      byHost: { ...state.byHost, [hostId]: { shells: shells ?? known?.shells ?? null, at: Date.now() } },
    }));
  };
  let request: Promise<{ shells: readonly ShellKind[] }>;
  try {
    request = sendHostCommand(hostId, { name: 'shell.detect' });
  } catch {
    request = Promise.reject(new Error('shell.detect could not be sent'));
  }
  request
    .then(
      (result) => {
        store(result.shells);
      },
      () => {
        store(null);
      },
    )
    .finally(() => {
      detecting.delete(hostId);
    });
}

/** The detected shells of a host, null before an answer. */
function detectedShells(hostId: HostId): readonly ShellKind[] | null {
  return hostShellStore.getState().byHost[hostId]?.shells ?? null;
}

/** Tests: forget every detection. */
export function resetHostShells(): void {
  detecting.clear();
  hostShellStore.setState({ byHost: {} });
}

/**
 * The shells offered for a session's computer (WP-104: by its platform; WP-105: a Linux computer's
 * detected list). Outside React (menus are built while rendering): asks the host in a microtask, so a
 * menu opened later shows the answer.
 */
export function sessionShellChoices(sessionKey: string | null): readonly ShellKind[] {
  const hostId = hostOfSession(sessionKey);
  queueMicrotask(() => {
    detectHostShells(hostId);
  });
  return shellChoices(getSessionPaths(sessionKey).flavor, detectedShells(hostId));
}

/** `sessionShellChoices` for components: re-renders when the platform or the detected list changes. */
export function useSessionShells(sessionKey: string | null): readonly ShellKind[] {
  const hostId = hostOfSession(sessionKey);
  const flavor = useStore(clientStore, (state) => selectHostFlavor(state, hostId));
  const detected = useStore(hostShellStore, (state) => state.byHost[hostId]?.shells ?? null);
  useEffect(() => {
    detectHostShells(hostId);
  }, [hostId, flavor]);
  return useMemo(() => shellChoices(flavor, detected), [flavor, detected]);
}

/**
 * The default shell of this computer's settings; WP-104: when the session's computer does not offer
 * it (a Windows setting on Linux, a shell that is not installed there), that computer's default.
 */
export function defaultShell(sessionKey: string | null = null): ShellKind {
  const setting = selectSettings(clientStore.getState()).console.defaultShell;
  const flavor = getSessionPaths(sessionKey).flavor;
  return effectiveShell(setting, flavor, shellChoices(flavor, detectedShells(hostOfSession(sessionKey))));
}

/**
 * A refusal of "Open shell" as a notice. WP-105: SHELL_NOT_FOUND of a Linux shell names that shell (the
 * error text speaks of Git for Windows, which is right only for Git Bash).
 */
function showShellRefusal(sessionKey: string, error: unknown): void {
  const payload = errorPayloadOf(error);
  const shell = shellKindSchema.safeParse(payload.params.shell);
  if (payload.code === 'SHELL_NOT_FOUND' && shell.success && shell.data !== 'gitbash') {
    showTextNotice(
      'navigation.shells.missing',
      { shell: translateNow(SHELL_LABELS[shell.data]) },
      { tone: 'warning', sessionKey },
    );
    return;
  }
  showErrorNotice(payload, { sessionKey });
}

/**
 * "Open shell in folder" (WP-97, ADR-238): `session.openShell {shell}` – the server opens cmd,
 * PowerShell or Git Bash as a window in the session's stored cwd (only on the local host). A
 * refusal (SHELL_NOT_FOUND, CWD_NOT_FOUND …) becomes a notice. Defence in depth like
 * `openFolderInExplorer`: a `cwd` that the host's rules reject is never sent.
 */
export function openShellIn(
  sessionKey: string,
  summary: SessionSummary,
  shell: ShellKind = defaultShell(sessionKey),
): void {
  if (getSessionPaths(sessionKey).issue(summary.cwd) !== null) {
    showErrorNotice(makeError('PATH_REJECTED'), { sessionKey });
    return;
  }
  sendCommand(sessionKey, { name: 'session.openShell', entryId: summary.entryId, shell }).catch(
    (error: unknown) => {
      showShellRefusal(sessionKey, error);
    },
  );
}

/** WP-99: "Terminal in panel" – opens the terminal tab of the side panel (help `?`, menu hint). */
export const OPEN_TERMINAL_KEYS = 'Alt+T';

/** Frames to wait for the terminal view (its lazy chunk loads on the first open). */
const TERMINAL_FOCUS_FRAMES = 300;

/**
 * Moves the focus into the active terminal of the session's terminal tab once it is rendered
 * (WP-99: `[data-slot="terminal-view"][data-active="true"]`, xterm's helper text area).
 */
export function focusSessionTerminal(sessionKey: string, frames = TERMINAL_FOCUS_FRAMES): void {
  const attempt = (left: number) => {
    const pane = document.querySelector(`[data-session-key="${sessionKey}"]`);
    const input = pane?.querySelector<HTMLTextAreaElement>(
      '[data-slot="terminal-view"][data-active="true"] .xterm-helper-textarea',
    );
    if (input !== null && input !== undefined) {
      input.focus();
      return;
    }
    if (left > 0) {
      requestAnimationFrame(() => {
        attempt(left - 1);
      });
    }
  };
  requestAnimationFrame(() => {
    attempt(frames);
  });
}

/**
 * "Terminal in panel" (WP-99, ADR-239): the side panel at the tab `terminal`, focus in the active
 * terminal. Only for sessions of this computer whose server has a pseudo console
 * (`selectTerminalAvailable`); a no-op otherwise.
 */
export function openTerminalPanel(sessionKey: string): void {
  if (!selectTerminalAvailable(clientStore.getState(), sessionKey)) return;
  if (!requestShell({ kind: 'sidePanel', sessionKey, tab: 'terminal' }))
    openSidePanel(sessionKey, 'terminal');
  focusSessionTerminal(sessionKey);
}

// ---- WP-105: a terminal the panel should show (the claude terminal of "Continue in terminal") ----

/** The terminal a session's terminal panel should make active; `token` tells two requests apart. */
export interface TerminalTarget {
  terminalId: TerminalId;
  token: number;
}

const terminalTargetStore = createStore<{ targets: Readonly<Partial<Record<string, TerminalTarget>>> }>(
  () => ({ targets: {} }),
);
let targetTokens = 0;

/**
 * Asks the session's terminal panel to make `terminalId` active and focus it – now when it is mounted,
 * else when it mounts. The panel (`features/terminal`) takes the target once the terminal is in its
 * list and clears it (`clearTerminalTarget`); a newer request replaces an older one.
 */
export function requestTerminalTarget(sessionKey: string, terminalId: TerminalId): void {
  const target: TerminalTarget = { terminalId, token: ++targetTokens };
  terminalTargetStore.setState((state) => ({ targets: { ...state.targets, [sessionKey]: target } }));
}

/** The pending target of a session's terminal panel (null = none). */
export function useTerminalTarget(sessionKey: string): TerminalTarget | null {
  return useStore(terminalTargetStore, (state) => state.targets[sessionKey] ?? null);
}

/** The panel took the target `token` (a newer request stays). */
export function clearTerminalTarget(sessionKey: string, token: number): void {
  terminalTargetStore.setState((state) => {
    if (state.targets[sessionKey]?.token !== token) return state;
    return {
      targets: Object.fromEntries(Object.entries(state.targets).filter(([key]) => key !== sessionKey)),
    };
  });
}

/** Tests: forget every target. */
export function resetTerminalTargets(): void {
  terminalTargetStore.setState({ targets: {} });
}

/** The terminal panel of the session at `terminalId` ("Show terminal with claude"). */
export function showSessionTerminal(sessionKey: string, terminalId: TerminalId): void {
  requestTerminalTarget(sessionKey, terminalId);
  openTerminalPanel(sessionKey);
}

/**
 * "Continue in terminal" (WP-105, 102e): `session.openInTerminal` – the server ends the SDK process and
 * starts `claude --resume …` in an embedded terminal of the session's computer; the panel then opens
 * at that terminal. Tracked like the external console (`trackHandoff`): the composer sends nothing
 * until the server answered. Rejects with the refusal (the caller shows it).
 */
export function continueInTerminal(sessionKey: string, entryId: EntryId): Promise<void> {
  return trackHandoff(sessionKey, sendCommand(sessionKey, { name: 'session.openInTerminal', entryId })).then(
    (result) => {
      showSessionTerminal(sessionKey, result.terminalId);
    },
  );
}

/**
 * "Archive" / "Restore" of the menus. WP-115 (ADR-250): archiving a worktree session first asks the
 * cleanup dialog (shell request `worktree.cleanup`, WP-114) what happens to its worktree and branch –
 * the dialog archives then; nobody takes the request → archived as before.
 */
export function archiveSession(sessionKey: string, summary: SessionSummary): void {
  if (
    !summary.archived &&
    summary.worktree !== null &&
    requestShell({ kind: 'worktree.cleanup', sessionKey, then: 'archive' })
  ) {
    return;
  }
  runSessionCommand(sessionKey, {
    name: 'session.setArchived',
    entryId: summary.entryId,
    archived: !summary.archived,
  });
}

/**
 * "Remove from Parallax…" of the menus. WP-115: a worktree session goes through the cleanup dialog
 * (`worktree.cleanup {then: 'remove'}`, WP-114), which removes the entry afterwards; nobody takes the
 * request → the confirmation dialog of WP-63 as before.
 */
export function requestRemove(sessionKey: string, summary: SessionSummary): void {
  if (summary.worktree !== null && requestShell({ kind: 'worktree.cleanup', sessionKey, then: 'remove' })) {
    return;
  }
  requestRemoveSession(sessionKey);
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

/**
 * WP-80 (WP-75 §4.4, ADR-208): the command behind an action that only the session's own computer
 * runs – visible programs on its desktop (Explorer, console), the console command (it holds the
 * profile's environment) and signing in. For a session of another computer these actions are left
 * out (`sessionAllows`), never just disabled.
 */
const ACTION_COMMANDS: Partial<Record<SessionActionId, CommandName>> = {
  openFolder: 'file.open',
  openShell: 'session.openShell',
  openExternal: 'session.openExternal',
  openInTerminal: 'session.openInTerminal',
  copyConsoleCommand: 'session.consoleCommand',
  signIn: 'profile.login',
};

function build(
  id: SessionActionId,
  sessionKey: string,
  summary: SessionSummary,
  place: RenamePlace,
): SessionAction | null {
  const command = ACTION_COMMANDS[id];
  if (command !== undefined && !sessionAllows(sessionKey, command)) return null;
  // WP-104: what the session's computer has on its desktop (all true on Windows).
  const capabilities = getSessionCapabilities(sessionKey);
  const entryId = summary.entryId;
  const external = summary.external !== null;
  const started = summary.sessionId !== null;
  switch (id) {
    case 'quickAsk':
      return {
        id,
        label: 'navigation.actions.quickAsk',
        icon: MessageCircleQuestionIcon,
        // The server refuses both (SESSION_ARCHIVED / SESSION_EXTERNAL); a dormant session starts.
        disabled: summary.archived || external,
        // After the menu closed: the popover then takes the focus and gives it back to the row.
        run: () => {
          runAfterMenu(sessionKey, () => {
            openQuickAsk(sessionKey);
          });
        },
      };
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
    case 'regenerateTitle':
      return {
        id,
        label: 'navigation.actions.regenerateTitle',
        icon: SparklesIcon,
        // Needs a conversation; the server refuses archived and external sessions as well.
        disabled: !started || external || summary.archived,
        run: () => {
          runSessionCommand(sessionKey, { name: 'session.regenerateTitle', entryId });
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
      // Explorer opens on the session's computer: only this computer's sessions (ADR-144, ACTION_COMMANDS).
      // WP-104: left out without a file manager there; on Linux its name is not "Explorer".
      if (!capabilities.fileManager) return null;
      return {
        id,
        label:
          getSessionPaths(sessionKey).flavor === 'win32'
            ? 'navigation.actions.openFolder'
            : 'navigation.actions.openFolderFileManager',
        icon: FolderOpenIcon,
        disabled: false,
        run: () => {
          openFolderInExplorer(sessionKey, summary);
        },
      };
    case 'openShell': {
      // A window on the session's computer: only this computer's sessions (ACTION_COMMANDS).
      // WP-104: left out without shell windows there (`capabilities.shellWindow`).
      if (!capabilities.shellWindow) return null;
      const preferred = defaultShell(sessionKey);
      return {
        id,
        label: 'navigation.actions.openShell',
        icon: TerminalIcon,
        disabled: false,
        run: () => {
          openShellIn(sessionKey, summary, preferred);
        },
        // WP-104: the shells of the session's computer (its platform).
        children: sessionShellChoices(sessionKey).map((shell): SessionSubAction => {
          const item: SessionSubAction = {
            id: shell,
            label: SHELL_LABELS[shell],
            disabled: false,
            run: () => {
              openShellIn(sessionKey, summary, shell);
            },
          };
          return shell === preferred
            ? { ...item, badge: 'navigation.shells.default', shortcut: OPEN_SHELL_KEYS }
            : item;
        }),
      };
    }
    case 'openTerminal':
      // WP-99: a pseudo console on this computer – left out for other computers and without ConPTY.
      if (!selectTerminalAvailable(clientStore.getState(), sessionKey)) return null;
      return {
        id,
        label: 'navigation.actions.openTerminal',
        icon: PanelRightOpenIcon,
        shortcut: OPEN_TERMINAL_KEYS,
        disabled: false,
        // After the menu closed: the terminal takes the focus.
        run: () => {
          runAfterMenu(sessionKey, () => {
            openTerminalPanel(sessionKey);
          });
        },
      };
    case 'newSessionHere':
      return {
        id,
        label: 'navigation.actions.newSessionHere',
        icon: FolderPlusIcon,
        disabled: false,
        run: () => {
          newSessionIn(summary.cwd, parseSessionKey(sessionKey)?.hostId ?? LOCAL_HOST_ID);
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
      // WP-104: left out when the session's computer cannot open a console window (`externalConsole`).
      if (!capabilities.externalConsole) return null;
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
    case 'openInTerminal': {
      // A pseudo console on the session's computer (`terminalAvailable`); left out otherwise.
      if (!selectTerminalAvailable(clientStore.getState(), sessionKey)) return null;
      const terminalId = summary.external?.terminalId ?? null;
      if (terminalId !== null) {
        return {
          id,
          label: 'navigation.console.showTerminal',
          icon: PanelRightOpenIcon,
          disabled: false,
          // After the menu closed: the terminal takes the focus.
          run: () => {
            runAfterMenu(sessionKey, () => {
              showSessionTerminal(sessionKey, terminalId);
            });
          },
        };
      }
      return {
        id,
        label: 'navigation.console.continueInTerminal',
        icon: SquareChevronRightIcon,
        disabled: !started || external || summary.archived || isHandoffPending(sessionKey),
        run: () => {
          continueInTerminal(sessionKey, entryId).catch((error: unknown) => {
            showErrorNotice(errorPayloadOf(error), { sessionKey });
          });
        },
      };
    }
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
          archiveSession(sessionKey, summary);
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
    case 'outputStyle':
      return {
        id,
        label: 'navigation.actions.outputStyle',
        icon: MessageSquareTextIcon,
        // The server refuses both (SESSION_ARCHIVED / SESSION_EXTERNAL); a dormant session starts.
        disabled: summary.archived || external,
        run: () => {
          requestShell({ kind: 'outputStyle', sessionKey });
        },
      };
    case 'signIn': {
      if (summary.remoteControl.error?.code !== 'REMOTE_CONTROL_AUTH') return null;
      const hostId = parseSessionKey(sessionKey)?.hostId;
      return {
        id,
        label: 'navigation.actions.signIn',
        icon: LogInIcon,
        disabled: false,
        run: () => {
          requestShell({ kind: 'login', profileId: summary.profileId, hostId });
        },
      };
    }
    case 'remove':
      return {
        id,
        label: 'navigation.actions.remove',
        icon: ListXIcon,
        disabled: false,
        run: () => {
          requestRemove(sessionKey, summary);
        },
      };
    case 'unread': {
      // WP-115: only a computer that knows `session.setUnread`; archived and external sessions too.
      if (!selectSessionFeature(clientStore.getState(), sessionKey, 'overview')) return null;
      if (!sessionAllows(sessionKey, 'session.setUnread')) return null;
      const unread = summary.status.unread;
      return {
        id,
        label: unread ? 'navigation.actions.markRead' : 'navigation.actions.markUnread',
        icon: unread ? MailOpenIcon : MailDotIcon,
        disabled: false,
        run: () => {
          runSessionCommand(sessionKey, { name: 'session.setUnread', entryId, unread: !unread });
        },
      };
    }
    case 'remoteControl': {
      // WP-64: the wish – a running session switches at once, a dormant one at its next start.
      const on = summary.remoteControl.wanted;
      return {
        id,
        label: on ? 'navigation.actions.remoteOff' : 'navigation.actions.remoteOn',
        icon: SmartphoneIcon,
        // The server refuses both (SESSION_ARCHIVED / SESSION_EXTERNAL).
        disabled: summary.archived || external,
        run: () => {
          runSessionCommand(sessionKey, { name: 'session.setRemoteControl', entryId, enabled: !on });
        },
      };
    }
    case 'openRemote': {
      const url = remoteLinkOf(summary.remoteControl);
      if (url === null) return null;
      return {
        id,
        label: 'navigation.actions.openRemote',
        icon: ExternalLinkIcon,
        disabled: false,
        run: () => {
          openClaudeSessionUrl(url);
        },
      };
    }
    case 'copyRemoteLink': {
      const url = remoteLinkOf(summary.remoteControl);
      if (url === null) return null;
      return {
        id,
        label: 'navigation.actions.copyRemoteLink',
        icon: LinkIcon,
        disabled: false,
        run: () => {
          copyRemoteLink(url);
        },
      };
    }
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
        const hint = (keys: string | undefined) => {
          if (keys === undefined) return null;
          const text = shortcutKeyLabels(keys, t).join('+');
          return kind === 'context' ? (
            <ContextMenuShortcut>{text}</ContextMenuShortcut>
          ) : (
            <DropdownMenuShortcut>{text}</DropdownMenuShortcut>
          );
        };
        const content = (
          <>
            <Icon aria-hidden />
            {t(action.label)}
            {hint(action.shortcut)}
          </>
        );
        if (action.children !== undefined) {
          const items = action.children.map((child) => {
            const childContent = (
              <>
                {t(child.label)}
                {child.badge === undefined ? null : (
                  <span className="text-muted-foreground text-xs">{t(child.badge)}</span>
                )}
                {hint(child.shortcut)}
              </>
            );
            return kind === 'context' ? (
              <ContextMenuItem
                key={child.id}
                data-action={action.id}
                data-choice={child.id}
                disabled={child.disabled}
                onSelect={child.run}
              >
                {childContent}
              </ContextMenuItem>
            ) : (
              <DropdownMenuItem
                key={child.id}
                data-action={action.id}
                data-choice={child.id}
                disabled={child.disabled}
                onSelect={child.run}
              >
                {childContent}
              </DropdownMenuItem>
            );
          });
          return kind === 'context' ? (
            <ContextMenuSub key={action.id}>
              <ContextMenuSubTrigger data-action={action.id} disabled={action.disabled}>
                {content}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="min-w-52">{items}</ContextMenuSubContent>
            </ContextMenuSub>
          ) : (
            <DropdownMenuSub key={action.id}>
              <DropdownMenuSubTrigger data-action={action.id} disabled={action.disabled}>
                {content}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-52">{items}</DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }
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
