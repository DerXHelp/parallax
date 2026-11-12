import { useCallback } from 'react';
import { windowsPathKey } from '@shared/paths';
import type { SessionViewState } from '@shared/sync';
import { useSessionSelector } from '@web/state/hooks';
import { fileToolIndex } from '../lib/file-tools';

/**
 * Hooks over the file tool calls of a session (lib/file-tools.ts): primitive values, so a component
 * re-renders only when a matching tool call finishes – not on every delta.
 */

/**
 * Time (ms) of the newest finished Write/Edit/MultiEdit/NotebookEdit on `path`, null without one.
 * `sessionKey` null: nothing is read (and the session is not subscribed).
 */
export function useFileWriteStamp(sessionKey: string | null, path: string | null): number | null {
  const key = path === null ? null : windowsPathKey(path);
  const select = useCallback(
    (view: SessionViewState) => (key === null ? null : (fileToolIndex(view.items).writes.get(key) ?? null)),
    [key],
  );
  return useSessionSelector(key === null ? null : sessionKey, select, null);
}

/** Changes whenever a file tool call of the session finishes ("Files of this session" refresh). */
export function useFileToolSignature(sessionKey: string): string {
  return useSessionSelector(sessionKey, selectSignature, '');
}

function selectSignature(view: SessionViewState): string {
  return fileToolIndex(view.items).signature;
}
