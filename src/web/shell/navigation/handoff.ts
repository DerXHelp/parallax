import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { EntryId } from '@shared/common';
import type { CommandResult } from '@shared/protocol';
import { sendCommand } from '@web/state/hooks';

/**
 * Handoffs on their way (WP41-07): from the click on "Open in external console" (session menus,
 * the composer's hint for terminal-only commands) until `session.openExternal` answers – about
 * 150 ms in which the summary does not say `external` yet. The composer sends nothing meanwhile:
 * the server would refuse the prompt (`SESSION_EXTERNAL`, R4-01) and its text would come back as a
 * draft after the return from the console. A counter per session (a second click counts too).
 */

interface HandoffState {
  pending: Readonly<Record<string, number>>;
}

const store = createStore<HandoffState>(() => ({ pending: {} }));

function change(sessionKey: string, delta: number): void {
  store.setState((state) => {
    const count = (state.pending[sessionKey] ?? 0) + delta;
    const others = Object.entries(state.pending).filter(([key]) => key !== sessionKey);
    return { pending: Object.fromEntries(count > 0 ? [...others, [sessionKey, count]] : others) };
  });
}

/** Counts the session as "handoff on its way" until `request` settles; returns `request`. */
export function trackHandoff<T>(sessionKey: string, request: Promise<T>): Promise<T> {
  change(sessionKey, 1);
  return request.finally(() => {
    change(sessionKey, -1);
  });
}

/** `session.openExternal` for this session, tracked (`trackHandoff`); the caller handles a refusal. */
export function openExternalConsole(
  sessionKey: string,
  entryId: EntryId,
): Promise<CommandResult<'session.openExternal'>> {
  return trackHandoff(sessionKey, sendCommand(sessionKey, { name: 'session.openExternal', entryId }));
}

export function isHandoffPending(sessionKey: string): boolean {
  return (store.getState().pending[sessionKey] ?? 0) > 0;
}

/** True while a handoff of this session is on its way; re-renders on changes. */
export function useHandoffPending(sessionKey: string): boolean {
  return useStore(store, (state) => (state.pending[sessionKey] ?? 0) > 0);
}

/** Tests: forget every pending handoff. */
export function resetHandoffs(): void {
  store.setState({ pending: {} });
}
