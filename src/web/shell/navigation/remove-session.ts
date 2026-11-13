import { useSyncExternalStore } from 'react';
import { parseSessionKey } from '@shared/common';
import type { ErrorPayload } from '@shared/errors';
import { errorPayloadOf } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { getSelectedSession, setSelectedSession } from '@web/state/selection';

/**
 * WP-63 §1.3 – remove sessions from Parallax only (`session.remove`; the files stay on disk):
 * which dialog is open (the confirmation of one session or "Clean up archive"), window-local and
 * module-level like `rename.ts`, so the menus of the sidebar and the header open the one dialog
 * that NavigationLayer mounts.
 */
export type RemoveDialog = { kind: 'session'; sessionKey: string } | { kind: 'cleanup' } | null;

let dialog: RemoveDialog = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): RemoveDialog => dialog;

/** "Remove from Parallax…" of the session menus: the confirmation dialog of this session. */
export function requestRemoveSession(sessionKey: string): void {
  dialog = { kind: 'session', sessionKey };
  emit();
}

/** "Clean up archive…" in the archive view. */
export function openArchiveCleanup(): void {
  dialog = { kind: 'cleanup' };
  emit();
}

export function closeRemoveDialog(): void {
  if (dialog === null) return;
  dialog = null;
  emit();
}

export function useRemoveDialog(): RemoveDialog {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * `session.remove` of one session. Shown in this window, the view goes back to the overview (like
 * any window whose session disappears, SessionPane). Rejects like `sendCommand` (`errorPayloadOf`).
 */
export async function removeSession(sessionKey: string): Promise<void> {
  const parsed = parseSessionKey(sessionKey);
  if (parsed === null) return;
  await sendCommand(sessionKey, { name: 'session.remove', entryId: parsed.entryId });
  if (getSelectedSession() === sessionKey) setSelectedSession(null);
}

export interface RemoveFailure {
  sessionKey: string;
  error: ErrorPayload;
}

/**
 * Several sessions ("Clean up archive"): one `session.remove` after the other (no burst of
 * process closes); the failures are returned, the others are gone.
 */
export async function removeSessions(sessionKeys: readonly string[]): Promise<RemoveFailure[]> {
  const failures: RemoveFailure[] = [];
  for (const sessionKey of sessionKeys) {
    try {
      await removeSession(sessionKey);
    } catch (error) {
      failures.push({ sessionKey, error: errorPayloadOf(error) });
    }
  }
  return failures;
}

/** Tests: no dialog open. */
export function resetRemoveDialog(): void {
  dialog = null;
  emit();
}
