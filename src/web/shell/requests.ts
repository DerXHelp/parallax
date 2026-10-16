import { useEffect, useEffectEvent } from 'react';
import type { ProfileId } from '@shared/common';

/**
 * Shell request channel (Phase 2 scaffold, WP-30 §4.14 C, ADR-115): cross links between shell parts
 * and features WITHOUT imports between them – like `decision-focus.ts`. A part that can do
 * something registers a handler while it is mounted (e.g. the "New session" dialog for
 * `newSession`, WP-36); any other part asks for it (`requestShell`), e.g. the composer for
 * `/rename` without an argument (`renameTitle`, handled by the header of WP-35).
 * Only ever called from a user action.
 */

/** Sections of the settings page (WP-38; `profiles` renders the `ProfilesSettings` slot of WP-36). */
export const SETTINGS_SECTIONS = [
  'general',
  'notifications',
  'sessions',
  'profiles',
  'server',
  'about',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

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
  | { kind: 'settings'; section?: SettingsSection };

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
