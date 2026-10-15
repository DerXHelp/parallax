import type { EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import { settingsSchema, type HostState, type SessionSummary, type TranscriptItem } from '@shared/model';
import type { Command, CommandName, CommandOf, CommandResult } from '@shared/protocol';
import { sampleHostState } from '@shared/samples';
import type { SessionViewState } from '@shared/sync';
import { newId, newUuid } from '../lib/ids';
import { CommandError, type ClientPresence, type CommandContext, type SessionSource } from './ports';

/**
 * In-memory `SessionSource` (test double for the hub; no engine, no claude). Holds host state,
 * summaries, materialized views and the full item history per entry (for `transcript.loadEarlier`),
 * and records every call. Command handlers can be overridden per command name; without a handler
 * the defaults below answer (or `NOT_IMPLEMENTED`).
 */

export type MemoryCommandHandler<N extends CommandName> = (
  cmd: CommandOf<N>,
  ctx: CommandContext,
) => CommandResult<N> | Promise<CommandResult<N>>;

export interface MemoryEntryInput {
  entryId: EntryId;
  summary?: SessionSummary;
  view?: SessionViewState;
  /** All items of the current conversation (loadEarlier source); default: the view's items. */
  history?: TranscriptItem[];
}

export interface MemorySessionSource extends SessionSource {
  host: HostState;
  readonly summaries: Map<EntryId, SessionSummary>;
  readonly views: Map<EntryId, SessionViewState>;
  readonly history: Map<EntryId, TranscriptItem[]>;
  readonly commands: { cmd: Command; ctx: CommandContext }[];
  readonly presenceUpdates: (readonly ClientPresence[])[];
  readonly subscriberCounts: { entryId: EntryId; count: number }[];
  readonly loadViewCalls: EntryId[];
  /** Delay of `loadView` in ms (race tests); default 0. */
  loadViewDelayMs: number;
  addEntry(input: MemoryEntryInput): void;
  setHandler<N extends CommandName>(name: N, handler: MemoryCommandHandler<N>): void;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createMemorySessionSource(options: { host?: HostState } = {}): MemorySessionSource {
  const handlers = new Map<CommandName, (cmd: Command, ctx: CommandContext) => unknown>();

  const source: MemorySessionSource = {
    host: options.host ?? sampleHostState(),
    summaries: new Map(),
    views: new Map(),
    history: new Map(),
    commands: [],
    presenceUpdates: [],
    subscriberCounts: [],
    loadViewCalls: [],
    loadViewDelayMs: 0,

    addEntry: (input) => {
      if (input.summary !== undefined) source.summaries.set(input.entryId, input.summary);
      if (input.view !== undefined) source.views.set(input.entryId, input.view);
      const history = input.history ?? input.view?.items;
      if (history !== undefined)
        source.history.set(
          input.entryId,
          [...history].sort((a, b) => a.order - b.order),
        );
    },

    setHandler: (name, handler) => {
      // The map is keyed by name, so a stored handler only ever receives its own command.
      handlers.set(name, (cmd, ctx) => {
        if (cmd.name !== name) throw new Error(`handler for ${name} got ${cmd.name}`);
        return handler(cmd as CommandOf<typeof name>, ctx);
      });
    },

    hostState: () => source.host,
    listSummaries: () => [...source.summaries.values()],

    loadView: async (entryId) => {
      source.loadViewCalls.push(entryId);
      if (source.loadViewDelayMs > 0) await sleep(source.loadViewDelayMs);
      const view = source.views.get(entryId);
      return view === undefined ? null : structuredClone(view);
    },

    handleCommand: async (cmd, ctx) => {
      source.commands.push({ cmd, ctx });
      const handler = handlers.get(cmd.name);
      if (handler !== undefined) return await handler(cmd, ctx);
      return defaultResult(cmd);
    },

    onPresenceChanged: (all) => {
      source.presenceUpdates.push(all);
    },

    onSubscribersChanged: (entryId, count) => {
      source.subscriberCounts.push({ entryId, count });
    },
  };

  function requireHistory(entryId: EntryId): TranscriptItem[] {
    const items = source.history.get(entryId);
    if (items === undefined) throw new CommandError(makeError('ENTRY_NOT_FOUND'));
    return items;
  }

  function defaultResult(cmd: Command): unknown {
    switch (cmd.name) {
      case 'session.create':
        return { entryId: newId('en'), messageUuid: cmd.prompt === undefined ? null : newUuid() };
      case 'session.sendPrompt':
        return { messageUuid: newUuid() };
      case 'session.interrupt':
        return { stillQueued: [] };
      case 'transcript.loadEarlier': {
        const items = requireHistory(cmd.entryId).filter((item) => item.order < cmd.beforeOrder);
        const start = Math.max(0, items.length - cmd.limit);
        return { items: items.slice(start), hasEarlier: start > 0 };
      }
      case 'settings.update': {
        const entries: [string, unknown][] = Object.entries(cmd.patch);
        const changes = Object.fromEntries(entries.filter(([, value]) => value !== undefined));
        source.host = {
          ...source.host,
          settings: settingsSchema.parse({ ...source.host.settings, ...changes }),
        };
        return { settings: source.host.settings };
      }
      case 'server.shutdown':
        return { sessionsStopped: 0 };
      case 'session.setModel':
      case 'session.setPermissionMode':
      case 'session.setEffort':
      case 'session.setFastMode':
      case 'session.rename':
      case 'session.close':
      case 'session.resume':
      case 'session.setPinned':
      case 'session.setArchived':
        return {};
      case 'decision.respond':
      case 'session.getContext':
      case 'session.refreshModels':
        throw new CommandError(makeError('NOT_IMPLEMENTED', { command: cmd.name }));
    }
  }

  return source;
}
