/**
 * Full-text search (WP-110 scaffolding; WP-112 fills it, ADR-255): `search.query` scans this host's
 * transcript logs, titles, turn summaries and plans in a worker thread (no index), and
 * `transcript.loadAround` loads the items around a hit (`TranscriptStore.readAround`). A newer query of
 * the same window (`CommandContext.clientId`) ends the older one with SEARCH_FAILED {reason: 'superseded'}.
 *
 * Stub until WP-112: both commands answer NOT_IMPLEMENTED.
 */
import { makeError } from '@shared/errors';
import type { HostCommandName } from '@shared/protocol';
import { CommandError, type HostCommandHandler } from '../sync/ports';

export const SEARCH_COMMAND_NAMES = [
  'search.query',
  'transcript.loadAround',
] as const satisfies readonly HostCommandName[];

export function createSearchCommands(): HostCommandHandler {
  return {
    names: SEARCH_COMMAND_NAMES,
    handle: (cmd) => Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }))),
  };
}
