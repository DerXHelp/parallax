/**
 * WP-67: the session info of the info dialog (`session.info`), the MCP actions (`session.mcpAction`)
 * and the reloads (`session.reload`). Only on request – no polling, no cache. All three need the
 * running process: a start still in the lifecycle lock is awaited first (like `session.interrupt`),
 * without a process → SESSION_NOT_RUNNING (no auto-wake: the dialog offers "start session").
 * A CLI that lacks the method answers `{available:false}` (no error, logged once by the backend);
 * failures → CLAUDE_CONTROL_FAILED (`method` + `detail`; for actions the CLI's error text, clipped).
 * Archived/external entries are refused by the entry gate (not in ARCHIVED_ALLOWED/EXTERNAL_ALLOWED).
 * Info answers (status rows may carry account data) are never logged.
 */
import type { McpAction, ReloadTarget, SessionInfoSectionName } from '@shared/model';
import type { CommandResult } from '@shared/protocol';
import { toError } from '../lib/async';
import { commandError, type EngineCore, type EntryState } from './entryState';

/** Length of a CLI error text passed to the dialog (CLAUDE_CONTROL_FAILED `detail`). */
const DETAIL_CHARS = 300;

/** The running process (after a start in the lock), else SESSION_NOT_RUNNING. */
async function liveAgent(s: EntryState): Promise<NonNullable<EntryState['runtime']>['agent']> {
  const runningNow = (): NonNullable<EntryState['runtime']> | null => {
    const runtime = s.runtime;
    return runtime !== null && s.phase === 'running' && runtime.alive && !runtime.closing ? runtime : null;
  };
  if (runningNow() === null && s.lifecycle.pending > 0) await s.lifecycle.idle();
  const runtime = runningNow();
  if (runtime === null) throw commandError('SESSION_NOT_RUNNING', { entryId: s.id });
  return runtime.agent;
}

function clipDetail(error: unknown): string {
  const message = toError(error).message.replace(/\s+/g, ' ').trim();
  return message.length > DETAIL_CHARS ? `${message.slice(0, DETAIL_CHARS - 1)}…` : message;
}

/** `session.info`: one section of the CLI's info; null from the backend = not available here. */
export async function readSessionInfo(
  core: EngineCore,
  s: EntryState,
  section: SessionInfoSectionName,
): Promise<CommandResult<'session.info'>> {
  const agent = await liveAgent(s);
  try {
    const data = await agent.readInfo(section);
    return { available: data !== null, data };
  } catch (error) {
    // Only the error, never an answer (status rows may carry account data).
    core.log.warn({ err: error, entryId: s.id, section }, 'session info request failed');
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'readInfo', detail: section });
  }
}

/** `session.mcpAction`: reconnect / enable / disable one MCP server of the running process. */
export async function mcpAction(
  core: EngineCore,
  s: EntryState,
  server: string,
  action: McpAction,
): Promise<CommandResult<'session.mcpAction'>> {
  const agent = await liveAgent(s);
  try {
    await agent.mcpAction(server, action);
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id, action }, 'MCP action failed');
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'mcpAction', detail: clipDetail(error) });
  }
  core.log.info({ entryId: s.id, action }, 'MCP action done');
  return {};
}

/** `session.reload`: reload the skills or the plugins of the running process. */
export async function reloadSession(
  core: EngineCore,
  s: EntryState,
  what: ReloadTarget,
): Promise<CommandResult<'session.reload'>> {
  const agent = await liveAgent(s);
  try {
    await agent.reload(what);
  } catch (error) {
    core.log.warn({ err: error, entryId: s.id, what }, 'reload failed');
    throw commandError('CLAUDE_CONTROL_FAILED', { method: 'reload', detail: clipDetail(error) });
  }
  core.log.info({ entryId: s.id, what }, 'reload done');
  return {};
}
