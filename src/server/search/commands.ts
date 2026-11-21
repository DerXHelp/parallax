/**
 * Full-text search (WP-110 scaffolding, WP-112, ADR-255): `search.query` scans this host's
 * transcript logs, titles, turn summaries and plans in a worker thread (no index, service.ts), and
 * `transcript.loadAround` loads the items around a hit (`TranscriptStore.readAround`). A newer query of
 * the same window (`CommandContext.clientId`) ends the older one with SEARCH_FAILED {reason: 'superseded'}.
 *
 * Without deps (the call in app/compose.ts until the coordinator wires them) both commands answer
 * NOT_IMPLEMENTED.
 */
import type { Logger } from 'pino';
import { makeError } from '@shared/errors';
import type { CommandResult, HostCommandName } from '@shared/protocol';
import {
  CommandError,
  type HostCommandHandler,
  type RegistryStore,
  type TranscriptStore,
} from '../sync/ports';
import { createSearchService, type SearchService } from './service';

export const SEARCH_COMMAND_NAMES = [
  'search.query',
  'transcript.loadAround',
] as const satisfies readonly HostCommandName[];

export interface SearchCommandDeps {
  home: string;
  registry: Pick<RegistryStore, 'list' | 'get'>;
  /** `flush` before a search (queued lines reach the files), `readAround` for the jump to a hit. */
  transcripts: Pick<TranscriptStore, 'readAround' | 'flush'>;
  logger?: Logger;
  /** Tests: an own service (timeouts, limits). */
  service?: SearchService;
}

export interface SearchCommandHandler extends HostCommandHandler {
  /** Shutdown: ends running searches. */
  close(): void;
}

export function createSearchCommands(deps?: SearchCommandDeps): SearchCommandHandler {
  if (deps === undefined) {
    return {
      names: SEARCH_COMMAND_NAMES,
      handle: (cmd) => Promise.reject(new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }))),
      close: () => undefined,
    };
  }
  const service =
    deps.service ??
    createSearchService({ home: deps.home, ...(deps.logger === undefined ? {} : { logger: deps.logger }) });
  return {
    names: SEARCH_COMMAND_NAMES,
    async handle(cmd, ctx) {
      switch (cmd.name) {
        case 'search.query': {
          const entries = deps.registry.list().filter((entry) => cmd.includeArchived || !entry.archived);
          await deps.transcripts.flush();
          return service.query(
            ctx.clientId,
            { text: cmd.text, includeToolOutput: cmd.includeToolOutput },
            entries,
          ) satisfies Promise<CommandResult<'search.query'>>;
        }
        case 'transcript.loadAround': {
          const entry = deps.registry.get(cmd.entryId);
          if (entry === undefined)
            throw new CommandError(makeError('ENTRY_NOT_FOUND', { entryId: cmd.entryId }));
          if (!entry.conversations.some((c) => c.id === cmd.conversationId)) {
            throw new CommandError(
              makeError('CONVERSATION_NOT_FOUND', { conversationId: cmd.conversationId }),
            );
          }
          const window = await deps.transcripts.readAround(
            cmd.entryId,
            cmd.conversationId,
            cmd.itemId,
            cmd.around,
          );
          if (window === null) {
            throw new CommandError(
              makeError('VALIDATION_FAILED', { reason: 'item_not_found' }, 'unknown item'),
            );
          }
          return window satisfies CommandResult<'transcript.loadAround'>;
        }
        default:
          throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
      }
    },
    close: () => {
      service.close();
    },
  };
}
