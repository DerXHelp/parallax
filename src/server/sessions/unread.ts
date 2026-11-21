/**
 * `session.setUnread` (WP-110 F6, WP-112): mark an entry unread or read. The mark goes through the
 * status reducer (StatusEvent `mark_unread`) and – unlike the "done" dot – is not cleared by a window
 * that still shows the session: the windows that show it at the moment of the mark are excused until
 * they switch to another session (or disconnect). The mark ends when a window opens the session
 * anew (`reopenedSinceMark`, called by the manager on every presence change) or with
 * `session.setUnread {unread: false}`. Hiding and showing the same window does not count as opening.
 */
import type { ClientId } from '@shared/common';
import type { CommandOf, CommandResult } from '@shared/protocol';
import type { ClientPresence } from '../sync/ports';
import type { EngineCore, EntryState } from './entryState';
import { windowClients } from './notifier';

/** Per marked entry: the windows that showed it when it was marked unread. */
const excusedViewers = new WeakMap<EntryState, Set<ClientId>>();

function viewersOf(all: readonly ClientPresence[], s: EntryState): readonly ClientPresence[] {
  return windowClients(all).filter((c) => c.presence.viewingEntryId === s.id);
}

export function setUnread(
  core: EngineCore,
  s: EntryState,
  cmd: CommandOf<'session.setUnread'>,
): Promise<CommandResult<'session.setUnread'>> {
  if (cmd.unread) {
    excusedViewers.set(s, new Set(viewersOf(core.publisher().presence(), s).map((c) => c.clientId)));
    s.reduce({ type: 'mark_unread', unread: true });
  } else {
    excusedViewers.delete(s);
    s.reduce({ type: 'mark_unread', unread: false });
    core.clearNotifications(s.id);
  }
  return Promise.resolve({});
}

/**
 * Presence changed: true when a visible window shows the entry and was not excused by an unread
 * mark – the usual "seen" (no mark), or a window that opened the entry after the mark. Excused
 * windows that no longer show the entry lose their excuse; the mark is forgotten once it ends.
 */
export function reopenedSinceMark(s: EntryState, all: readonly ClientPresence[]): boolean {
  const viewers = viewersOf(all, s);
  const excused = excusedViewers.get(s);
  if (excused === undefined) return viewers.some((c) => c.presence.visible);
  for (const id of [...excused]) {
    if (!viewers.some((c) => c.clientId === id)) excused.delete(id);
  }
  const opened = viewers.some((c) => c.presence.visible && !excused.has(c.clientId));
  if (opened || !s.facts.unread) excusedViewers.delete(s);
  return opened;
}
