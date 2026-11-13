import { useEffect, useEffectEvent } from 'react';
import type { HostId, ProfileId } from '@shared/common';

/**
 * Shell request channel (Phase 2 scaffold, WP-30 §4.14 C, ADR-115): cross links between shell parts
 * and features WITHOUT imports between them – like `decision-focus.ts`. A part that can do
 * something registers a handler while it is mounted (e.g. the "New session" dialog for
 * `newSession`, WP-36); any other part asks for it (`requestShell`), e.g. the composer for
 * `/rename` without an argument (`renameTitle`, handled by the header of WP-35).
 * Only ever called from a user action.
 */

/**
 * Sections of the settings page (WP-38; `profiles` renders the `ProfilesSettings` slot of WP-36;
 * Phase 3: `files` = editor and file settings, WP-58).
 */
export const SETTINGS_SECTIONS = [
  'general',
  'notifications',
  'sessions',
  'files',
  'profiles',
  'server',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * Tabs of the side panel of a session pane (Phase 3, ADR-150; host: shell/side-panel). WP-69:
 * `subagent` = the read-only transcript of one subagent (shown once one was opened).
 */
export const SIDE_PANEL_TABS = ['plan', 'file', 'files', 'tasks', 'subagent'] as const;
export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number];

export type ShellRequest =
  /** Open "New session", optionally pre-filled ("New session in this project…"). */
  | { kind: 'newSession'; cwd?: string; profileId?: ProfileId }
  /** Inline title edit of a session (double click, F2, `/rename` without argument). */
  | { kind: 'renameTitle'; sessionKey: string }
  /** "Earlier conversations" of a session (`/resume`). */
  | { kind: 'conversations'; sessionKey: string }
  /** Session info panel (`/status`). */
  | { kind: 'sessionInfo'; sessionKey: string }
  /** Quick switcher (Ctrl+K). */
  | { kind: 'quickSwitcher' }
  /** Settings page, optionally at a section. */
  | { kind: 'settings'; section?: SettingsSection }
  // ---- Phase 3 (WP-50 §4.14 C, ADR-150) ----
  /** Show a file in the viewer tab of the side panel (FileLink, "Dateien dieser Session"). */
  | { kind: 'openFile'; sessionKey: string; path: string; line?: number | null; col?: number | null }
  /** Open the side panel of a session at a tab; `null` closes it (handled by SidePanelHost). */
  | { kind: 'sidePanel'; sessionKey: string; tab: SidePanelTab | null }
  /**
   * WP-69: the transcript of one subagent in the tab `subagent` (the Agent card's "Open
   * transcript"; the tab shows the latest one). `title`: the card's title (description, else type).
   */
  | { kind: 'openSubagent'; sessionKey: string; agentId: string; title: string; subagentType?: string | null }
  /**
   * Files dropped on the session pane or picked in the menu → the composer attaches them.
   * `folders`: folders the drop left out (`transferFiles`, CR3-01) – the composer shows its hint.
   */
  | { kind: 'attachFiles'; sessionKey: string; files: readonly File[]; folders?: number }
  // ---- WP-66 ----
  /**
   * Text back into the composer of a session (a withdrawn queued message, „Zurückholen“): the
   * composer appends it to a draft (new paragraph) or fills the empty field, and takes the focus.
   */
  | { kind: 'composerText'; sessionKey: string; text: string }
  // ---- WP-70 ----
  /**
   * Sign in a profile from Parallax: the small sign-in dialog (NavigationLayer, lazy chunk). `hostId`:
   * the profile's host (default local). `modal`: asked from inside a modal dialog (new session,
   * settings) – the sign-in dialog is modal then too (a non-modal layer outside that dialog's tree
   * would dismiss it).
   */
  | { kind: 'login'; profileId: ProfileId; hostId?: HostId; modal?: boolean }
  /** The output style of a session's project (header "…" menu; small dialog, lazy chunk). */
  | { kind: 'outputStyle'; sessionKey: string };

export type ShellRequestKind = ShellRequest['kind'];
export type ShellRequestOf<K extends ShellRequestKind> = Extract<ShellRequest, { kind: K }>;

/** Return true when the request was handled; false passes it on to the next older handler. */
export type ShellRequestHandler<K extends ShellRequestKind> = (request: ShellRequestOf<K>) => boolean;

type AnyHandler = (request: ShellRequest) => boolean;

const handlers = new Map<ShellRequestKind, AnyHandler[]>();

function isKind<K extends ShellRequestKind>(request: ShellRequest, kind: K): request is ShellRequestOf<K> {
  return request.kind === kind;
}

/** Registers a handler (the newest one is asked first); returns the remove function. */
export function registerShellRequestHandler<K extends ShellRequestKind>(
  kind: K,
  handler: ShellRequestHandler<K>,
): () => void {
  const wrapped: AnyHandler = (request) => isKind(request, kind) && handler(request);
  const list = handlers.get(kind) ?? [];
  list.push(wrapped);
  handlers.set(kind, list);
  return () => {
    const current = handlers.get(kind);
    if (current === undefined) return;
    const index = current.indexOf(wrapped);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) handlers.delete(kind);
  };
}

/** Delivers the request to the newest handler of its kind that takes it; false = nobody did. */
export function requestShell(request: ShellRequest): boolean {
  const list = handlers.get(request.kind) ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.(request) === true) return true;
  }
  return false;
}

/** Hook form of registerShellRequestHandler: handles the kind while the component is mounted. */
export function useShellRequestHandler<K extends ShellRequestKind>(
  kind: K,
  handler: ShellRequestHandler<K>,
): void {
  const run = useEffectEvent((request: ShellRequestOf<K>) => handler(request));
  useEffect(() => registerShellRequestHandler(kind, (request) => run(request)), [kind]);
}
