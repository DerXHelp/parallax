/**
 * WP-69: `session.subagentTranscript` – the read-only transcript of one subagent for the side panel.
 * The CLI keeps it in `agent-<agentId>.jsonl` next to the session (`getSubagentMessages`, read in the
 * history worker of the profile's config dir); it becomes items of a list of its OWN (orders from 1,
 * never mixed into the session's conversation, nothing written to the log). Only on request – the
 * panel polls while the subagent runs.
 *
 * Polling a growing file must stay cheap (ADR-154): per (entry, Claude session, agent) the engine
 * keeps what it read (an incremental history adapter, `createHistoryAccumulator`) and asks the
 * backend only for messages from the known count on (the worker slices; only the new part crosses
 * threads). The uuid before the slice must match the last one read – otherwise the file is not the
 * one read before and the transcript is read again from the start. At most `SUBAGENT_CACHE_MAX`
 * transcripts are kept, each at most `SUBAGENT_CACHE_IDLE_MS` after its last read; reads of one
 * transcript run one after another (two windows polling the same agent).
 *
 * No process needed (file only): works for dormant, archived and external entries (gate lists in
 * entryState.ts). `running` = the process runs and the agent's task is live (a tool call with that
 * task in a live status, or a listed background task). Errors: CONVERSATION_NOT_FOUND,
 * SESSION_NOT_STARTED (no Claude session yet), FILE_NOT_READABLE (read failed or timed out; the
 * cause is logged). A missing file is an empty page.
 */
import type { Conversation, TranscriptItem } from '@shared/model';
import type { CommandOf, CommandResult } from '@shared/protocol';
import type { LaunchSpec } from '../claude/ports';
import type { HistoryMessage, SubagentHistorySlice } from '../backend/types';
import { CommandError } from '../sync/ports';
import { commandError, type EngineCore, type EntryState } from './entryState';
import type { HistoryAccumulator, HistoryOpenStatus } from './normalizer';

/** Transcripts kept per engine (LRU). */
export const SUBAGENT_CACHE_MAX = 8;
/** A transcript nobody read for this long is dropped (its next read starts from the file again). */
export const SUBAGENT_CACHE_IDLE_MS = 5 * 60_000;
/** How long a launch spec (profile env → the worker's config dir) is reused per entry. */
export const SUBAGENT_LAUNCH_REUSE_MS = 60_000;

/** Tool-call statuses of a live agent task. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'background']);

interface CachedTranscript {
  readonly key: string;
  /** The CLI's message count read so far. */
  messages: number;
  /** uuid of the last message read (the next slice's `previousUuid` must equal it). */
  lastUuid: string | null;
  acc: HistoryAccumulator;
  snapshot: { openAs: HistoryOpenStatus; items: TranscriptItem[] } | null;
  usedAt: number;
  /** Reads of this transcript, one after another. */
  queue: Promise<void>;
}

interface EngineCaches {
  transcripts: Map<string, CachedTranscript>;
  launches: Map<string, { at: number; launch: LaunchSpec }>;
}

const cachesByCore = new WeakMap<EngineCore, EngineCaches>();

function cachesOf(core: EngineCore): EngineCaches {
  let caches = cachesByCore.get(core);
  if (caches === undefined) {
    caches = { transcripts: new Map(), launches: new Map() };
    cachesByCore.set(core, caches);
  }
  return caches;
}

/**
 * True while the agent works: the process runs and a tool call carries the agent's task in a live
 * status (foreground or background), or the CLI lists it as a background task.
 */
export function isSubagentRunning(s: EntryState, agentId: string): boolean {
  const runtime = s.runtime;
  const view = s.mirror;
  if (runtime === null || !runtime.alive || view === null) return false;
  if (view.detail.backgroundTasks.some((task) => task.taskId === agentId)) return true;
  return view.items.some(
    (item) => item.kind === 'tool_call' && item.task?.taskId === agentId && LIVE_STATUSES.has(item.status),
  );
}

function newAccumulator(core: EngineCore, s: EntryState, conversation: Conversation): HistoryAccumulator {
  return core.normalizer.createHistoryAccumulator({
    entryId: s.id,
    conversationId: conversation.id,
    nextOrder: 1,
    storeBlob: (data, mediaType, name) => core.stores.blobs.put(data, mediaType, name),
    now: core.now,
  });
}

/** The cached transcript of `key` (LRU order refreshed, idle and surplus entries dropped). */
function cachedTranscript(
  core: EngineCore,
  key: string,
  create: () => HistoryAccumulator,
): CachedTranscript {
  const { transcripts } = cachesOf(core);
  const now = core.now().getTime();
  for (const [k, entry] of transcripts) {
    if (now - entry.usedAt > SUBAGENT_CACHE_IDLE_MS) transcripts.delete(k);
  }
  let entry = transcripts.get(key);
  if (entry === undefined) {
    entry = {
      key,
      messages: 0,
      lastUuid: null,
      acc: create(),
      snapshot: null,
      usedAt: now,
      queue: Promise.resolve(),
    };
  } else {
    transcripts.delete(key);
    entry.usedAt = now;
  }
  transcripts.set(key, entry);
  while (transcripts.size > SUBAGENT_CACHE_MAX) {
    const oldest = transcripts.keys().next();
    if (oldest.done === true) break;
    transcripts.delete(oldest.value);
  }
  return entry;
}

async function launchFor(core: EngineCore, s: EntryState): Promise<LaunchSpec> {
  const { launches } = cachesOf(core);
  const now = core.now().getTime();
  const known = launches.get(s.id);
  if (known !== undefined && now - known.at < SUBAGENT_LAUNCH_REUSE_MS) return known.launch;
  const launch = await core.claude.launchSpecFor(s.entry.profileId, s.id);
  launches.set(s.id, { at: now, launch });
  return launch;
}

/** The subagent's own messages are its top level (their `parent_tool_use_id` is the Agent call outside). */
function topLevel(messages: readonly HistoryMessage[]): HistoryMessage[] {
  return messages.map((message) => (message.parentToolUseId === null ? message : { ...message, parentToolUseId: null }));
}

async function refresh(
  core: EngineCore,
  s: EntryState,
  cache: CachedTranscript,
  conversation: Conversation,
  sessionId: string,
  agentId: string,
): Promise<void> {
  let launch: LaunchSpec;
  try {
    launch = await launchFor(core, s);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    core.log.warn({ err: error, entryId: s.id }, 'subagent transcript: no launch spec');
    throw commandError('FILE_NOT_READABLE', { agentId });
  }
  const read = async (from: number): Promise<SubagentHistorySlice> => {
    try {
      return await core.backend.readSubagentHistory({ sessionId, cwd: s.entry.cwd, launch, agentId, from });
    } catch (error) {
      core.log.warn({ err: error, entryId: s.id, agentId }, 'subagent transcript could not be read');
      throw commandError('FILE_NOT_READABLE', { agentId });
    }
  };
  let slice = await read(cache.messages);
  if (slice.total < cache.messages || slice.previousUuid !== cache.lastUuid) {
    // Not the file read before (rewritten, another chain): read it again from the start.
    core.log.debug({ entryId: s.id, agentId, known: cache.messages, total: slice.total }, 'subagent transcript re-read');
    cache.acc = newAccumulator(core, s, conversation);
    cache.messages = 0;
    cache.lastUuid = null;
    cache.snapshot = null;
    if (slice.total > 0) slice = await read(0);
    else slice = { ...slice, previousUuid: null, messages: [] };
  }
  if (slice.total === cache.messages && slice.lastUuid === cache.lastUuid) return;
  cache.acc.add(topLevel(slice.messages));
  cache.messages = slice.total;
  cache.lastUuid = slice.lastUuid;
  cache.snapshot = null;
}

function snapshot(cache: CachedTranscript, openAs: HistoryOpenStatus): TranscriptItem[] {
  if (cache.snapshot?.openAs !== openAs) cache.snapshot = { openAs, items: cache.acc.items(openAs) };
  return cache.snapshot.items;
}

/** `session.subagentTranscript`: one page of the agent's items (newest `limit` for `offset` null). */
export async function readSubagentTranscript(
  core: EngineCore,
  s: EntryState,
  cmd: CommandOf<'session.subagentTranscript'>,
): Promise<CommandResult<'session.subagentTranscript'>> {
  const conversation =
    cmd.conversationId === null
      ? s.conversation()
      : s.entry.conversations.find((candidate) => candidate.id === cmd.conversationId);
  if (conversation === undefined) {
    throw commandError('CONVERSATION_NOT_FOUND', { conversationId: cmd.conversationId ?? '' });
  }
  const sessionId = conversation.sessionId;
  if (sessionId === null) throw commandError('SESSION_NOT_STARTED', { entryId: s.id });
  const key = `${s.id}|${sessionId}|${cmd.agentId}`;
  const cache = cachedTranscript(core, key, () => newAccumulator(core, s, conversation));
  const run = cache.queue.then(() => refresh(core, s, cache, conversation, sessionId, cmd.agentId));
  cache.queue = run.catch(() => undefined);
  await run;
  const running = isSubagentRunning(s, cmd.agentId);
  const items = snapshot(cache, running ? 'running' : 'interrupted');
  const total = items.length;
  const offset = cmd.offset === null ? Math.max(0, total - cmd.limit) : Math.min(cmd.offset, total);
  return { items: items.slice(offset, offset + cmd.limit), offset, total, running };
}
