/**
 * `session.setUnread` (WP-110 scaffolding; WP-112 fills it, F6): mark an entry unread or read. The
 * mark goes through the status reducer (StatusEvent `mark_unread`) and – unlike the "done" dot – is
 * not cleared by a window that still shows the session; it ends when the session is opened again.
 *
 * Stub until WP-112: the command is routed (commands.ts, gates in entryState.ts) and answers
 * NOT_IMPLEMENTED.
 */
import type { CommandOf, CommandResult } from '@shared/protocol';
import { commandError, type EngineCore, type EntryState } from './entryState';

export function setUnread(
  _core: EngineCore,
  _s: EntryState,
  cmd: CommandOf<'session.setUnread'>,
): Promise<CommandResult<'session.setUnread'>> {
  return Promise.reject(commandError('NOT_IMPLEMENTED', { command: cmd.name }));
}
