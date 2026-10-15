import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Logger } from 'pino';
import { conversationIdSchema, type ConversationId, type EntryId } from '@shared/common';
import { makeError } from '@shared/errors';
import type { TranscriptItem } from '@shared/model';
import { logger as rootLogger, shouldLogRepeated } from '../lib/logger';
import { fsErrorCode } from '../lib/paths';
import { transcriptLogLineSchema, type TranscriptLogLine, type TranscriptStore } from '../sync/ports';
import { entryDir } from './decisions';
import { withFsRetry, type StoreWarningSink } from './jsonStore';

/**
 * Append-only transcript log per conversation (A.3, architecture §8):
 * `entries/<entryId>/<conversationId>.transcript.jsonl`, one `transcriptLogLineSchema` line per
 * persisted op. Buffered single writer per file; loading folds by id (last line wins), sorts by
 * `order`, skips and counts broken lines. Streaming items are never persisted (dropped + counted).
 * A small LRU cache keeps folded conversations, updated on append.
 *
 * R1-16: in test/dev mode every appended line is checked against the schema (an invalid line would
 * be written and silently dropped on the next load); a file whose appends keep failing raises one
 * host warning STORE_WRITE_FAILED (cleared by the next successful write).
 */

/**
 * Like the hub (R0-28): module default `throw` under Vitest/NODE_ENV=test, else `off`; the server
 * passes `config.validation` (default `log`, also in production – R3-05).
 */
export type TranscriptValidation = 'off' | 'log' | 'throw';

/** Consecutive failed flushes of one file before the host warning. */
export const TRANSCRIPT_FAILURES_BEFORE_WARNING = 3;

export const TRANSCRIPT_SUFFIX = '.transcript.jsonl';

export function transcriptPath(home: string, entryId: EntryId, conversationId: ConversationId): string {
  return path.join(
    entryDir(home, entryId),
    `${conversationIdSchema.parse(conversationId)}${TRANSCRIPT_SUFFIX}`,
  );
}

export interface TranscriptStoreOptions {
  home: string;
  /** Delay of the buffered write (default 50 ms). */
  flushMs?: number;
  /** Folded conversations kept in memory (default 8). */
  cacheSize?: number;
  /** Schema check of appended lines (default: `throw` under Vitest/NODE_ENV=test, else `off`). */
  validation?: TranscriptValidation;
  /** Host warnings (STORE_WRITE_FAILED after repeated append failures). */
  warnings?: StoreWarningSink;
  logger?: Logger;
}

export interface TranscriptStoreStats {
  appendedLines: number;
  brokenLines: number;
  droppedStreaming: number;
  /** Lines that failed the schema check (`log` mode: dropped, not written; R3-05). */
  invalidLines: number;
}

export interface FileTranscriptStore extends TranscriptStore {
  stats(): TranscriptStoreStats;
  close(): Promise<void>;
}

interface QueuedLine {
  line: TranscriptLogLine;
  text: string;
}

interface FileState {
  file: string;
  /** Appended but not yet written lines (removed only after a successful write). */
  queue: QueuedLine[];
  /** Serializes writes and reads of this file. */
  chain: Promise<void>;
  tailChecked: boolean;
  /** Consecutive failed flushes; the warning is raised once per failure series. */
  failures: number;
}

function defaultValidation(): TranscriptValidation {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === 'test' ? 'throw' : 'off';
}

type Fold = Map<string, TranscriptItem>;

interface CachedFold {
  fold: Fold;
  sorted: TranscriptItem[] | null;
}

/** Deltas and streaming items are live-only (A.3). */
export function isStreamingItem(item: TranscriptItem): boolean {
  switch (item.kind) {
    case 'assistant_text':
    case 'thinking':
      return item.streaming;
    case 'tool_call':
      return item.status === 'streaming_input';
    default:
      return false;
  }
}

function applyLine(fold: Fold, line: TranscriptLogLine): void {
  if (line.op === 'upsert') fold.set(line.item.id, line.item);
  else fold.delete(line.itemId);
}

function lowerBound(items: readonly TranscriptItem[], order: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = items[mid];
    if (item !== undefined && item.order < order) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createTranscriptStore(options: TranscriptStoreOptions): FileTranscriptStore {
  const log = (options.logger ?? rootLogger).child({ module: 'transcripts' });
  const flushMs = options.flushMs ?? 50;
  const cacheSize = Math.max(1, options.cacheSize ?? 8);
  const files = new Map<string, FileState>();
  const cache = new Map<string, CachedFold>();
  const stats: TranscriptStoreStats = {
    appendedLines: 0,
    brokenLines: 0,
    droppedStreaming: 0,
    invalidLines: 0,
  };
  const validation = options.validation ?? defaultValidation();
  let timer: NodeJS.Timeout | null = null;

  const stateFor = (file: string): FileState => {
    let state = files.get(file);
    if (state === undefined) {
      state = { file, queue: [], chain: Promise.resolve(), tailChecked: false, failures: 0 };
      files.set(file, state);
    }
    return state;
  };

  const touchCache = (file: string, entry: CachedFold) => {
    cache.delete(file);
    cache.set(file, entry);
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
  };

  /** A crash can leave a partial last line: start the next append on a fresh line. */
  const needsLeadingNewline = async (file: string): Promise<boolean> => {
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') return false;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return false;
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  };

  const writeQueued = async (state: FileState): Promise<void> => {
    const batch = state.queue.slice();
    if (batch.length === 0) return;
    await mkdir(path.dirname(state.file), { recursive: true });
    let data = batch.map((queued) => queued.text).join('');
    if (!state.tailChecked) {
      if (await needsLeadingNewline(state.file)) data = `\n${data}`;
      state.tailChecked = true;
    }
    await withFsRetry(() => appendFile(state.file, data, 'utf8'));
    state.queue.splice(0, batch.length);
  };

  const flushFile = (state: FileState): Promise<void> => {
    state.chain = state.chain
      .then(() => writeQueued(state))
      .then(() => {
        state.failures = 0;
      })
      .catch((error: unknown) => {
        // Lines stay queued; the next flush tries again.
        state.failures += 1;
        log.error(
          { err: error, file: path.basename(state.file), failures: state.failures },
          'transcript append failed',
        );
        if (state.failures === TRANSCRIPT_FAILURES_BEFORE_WARNING) {
          options.warnings?.add(
            makeError('STORE_WRITE_FAILED', {
              file: path.basename(state.file),
              reason: fsErrorCode(error) ?? 'unknown',
            }),
          );
        }
      });
    return state.chain;
  };

  const flushAll = async () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await Promise.all([...files.values()].map((state) => flushFile(state)));
  };

  const scheduleFlush = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flushAll();
    }, flushMs);
    timer.unref();
  };

  const readFold = async (file: string): Promise<Fold> => {
    const fold: Fold = new Map();
    let broken = 0;
    try {
      const lines = createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const text of lines) {
        if (text.trim() === '') continue;
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          broken += 1;
          continue;
        }
        const parsed = transcriptLogLineSchema.safeParse(raw);
        if (parsed.success) applyLine(fold, parsed.data);
        else broken += 1;
      }
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') throw error;
    }
    if (broken > 0) {
      stats.brokenLines += broken;
      log.warn({ file: path.basename(file), broken }, 'transcript: skipped broken lines');
    }
    return fold;
  };

  /** Folded, sorted items of a conversation (cache, otherwise file + unwritten lines). */
  const sortedItems = async (entryId: EntryId, conversationId: ConversationId): Promise<TranscriptItem[]> => {
    const file = transcriptPath(options.home, entryId, conversationId);
    let entry = cache.get(file);
    if (entry === undefined) {
      const state = stateFor(file);
      // Read inside the file's chain: no write runs concurrently, so the file holds exactly the
      // lines that are no longer queued. The cache entry is registered synchronously after the
      // read, so every later append() updates it.
      const run = state.chain.then(async () => {
        const fold = await readFold(file);
        for (const queued of state.queue) applyLine(fold, queued.line);
        const created: CachedFold = { fold, sorted: null };
        touchCache(file, created);
        return created;
      });
      state.chain = run.then(
        () => undefined,
        () => undefined,
      );
      entry = await run;
    } else {
      touchCache(file, entry);
    }
    entry.sorted ??= [...entry.fold.values()].sort((a, b) => a.order - b.order);
    return entry.sorted;
  };

  return {
    append: (entryId, conversationId, line) => {
      const file = transcriptPath(options.home, entryId, conversationId);
      if (line.op === 'upsert' && isStreamingItem(line.item)) {
        stats.droppedStreaming += 1;
        log.debug({ itemId: line.item.id }, 'transcript: streaming item not persisted');
        return;
      }
      if (validation !== 'off') {
        const parsed = transcriptLogLineSchema.safeParse(line);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const detail = `${issue?.path.map(String).join('.') ?? ''}: ${issue?.message ?? 'invalid'}`;
          if (validation === 'throw') throw new Error(`TranscriptStore: invalid log line – ${detail}`);
          stats.invalidLines += 1;
          if (shouldLogRepeated(stats.invalidLines)) {
            log.error({ detail, count: stats.invalidLines }, 'invalid transcript line dropped');
          }
          return;
        }
      }
      stateFor(file).queue.push({ line, text: `${JSON.stringify(line)}\n` });
      stats.appendedLines += 1;
      const cached = cache.get(file);
      if (cached !== undefined) {
        applyLine(cached.fold, line);
        cached.sorted = null;
      }
      scheduleFlush();
    },
    readTail: async (entryId, conversationId, limit) => {
      const items = await sortedItems(entryId, conversationId);
      const count = Math.max(0, limit);
      const start = Math.max(0, items.length - count);
      return { items: items.slice(start), hasEarlier: start > 0 };
    },
    readBefore: async (entryId, conversationId, beforeOrder, limit) => {
      const items = await sortedItems(entryId, conversationId);
      const end = lowerBound(items, beforeOrder);
      const start = Math.max(0, end - Math.max(0, limit));
      return { items: items.slice(start, end), hasEarlier: start > 0 };
    },
    flush: flushAll,
    stats: () => ({ ...stats }),
    close: flushAll,
  };
}
