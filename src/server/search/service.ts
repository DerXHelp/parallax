/**
 * Full-text search without an index (WP-112, ADR-255): one worker thread per `search.query`
 * (workerSource.ts), at most `maxConcurrent` at a time (further queries wait in order). A newer
 * query of the same window ends its older one – running (worker terminated) or waiting – with
 * SEARCH_FAILED {reason: 'superseded'}; a query that runs longer than `timeoutMs` ends with
 * `timeout`, a crashed or failing worker with `worker`. The worker's answer is checked with zod;
 * invalid hits are dropped and counted (never sent).
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Logger } from 'pino';
import { z } from 'zod';
import { LIMITS, type ClientId } from '@shared/common';
import { makeError, type SearchFailedReason } from '@shared/errors';
import { searchHitSchema, type Entry, type SearchHit } from '@shared/model';
import { toError } from '../lib/async';
import { logger as rootLogger } from '../lib/logger';
import { planPath } from '../store/decisions';
import { transcriptPath } from '../store/transcripts';
import { CommandError } from '../sync/ports';
import { SEARCH_WORKER_SOURCE } from './workerSource';

/** A search ends after this long (SEARCH_FAILED timeout). */
export const SEARCH_TIMEOUT_MS = 20_000;
/** Searches running at the same time (each one worker thread); more wait. */
export const SEARCH_MAX_CONCURRENT = 2;
/** Longer log lines are skipped (never held in memory). */
export const SEARCH_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Heap limit of one search worker. */
export const SEARCH_WORKER_HEAP_MB = 128;
/** Characters of the snippet before the first match (when the text is longer than the snippet). */
export const SEARCH_SNIPPET_LEAD = 80;

export interface SearchQuery {
  text: string;
  includeToolOutput: boolean;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

export interface SearchServiceOptions {
  home: string;
  logger?: Logger;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxLineBytes?: number;
  /** Hits at most (default LIMITS.searchHitsMax). */
  limit?: number;
}

export interface SearchService {
  /** Searches `entries` (the caller filters archived ones); throws CommandError(SEARCH_FAILED). */
  query(clientId: ClientId, query: SearchQuery, entries: readonly Entry[]): Promise<SearchResult>;
  /** Ends every running and waiting search (`failed`). */
  close(): void;
}

/** What the worker gets (`workerData`). */
interface SearchJobEntry {
  entryId: string;
  title: string;
  lastActivityAt: string;
  summary: { text: string; at: string } | null;
  conversations: { conversationId: string; file: string }[];
  plansDir: string;
}

interface SearchJob {
  text: string;
  includeToolOutput: boolean;
  limit: number;
  snippetChars: number;
  snippetLead: number;
  rangesMax: number;
  maxLineBytes: number;
  entries: SearchJobEntry[];
}

const workerReplySchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    hits: z.array(z.unknown()),
    truncated: z.boolean(),
    skippedLines: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

interface Job {
  clientId: ClientId;
  data: SearchJob;
  resolve(result: SearchResult): void;
  reject(error: CommandError): void;
  /** Set while the worker runs. */
  worker: Worker | null;
  timer: NodeJS.Timeout | null;
  done: boolean;
}

function searchFailed(reason: SearchFailedReason): CommandError {
  return new CommandError(makeError('SEARCH_FAILED', { reason }));
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  const log = (options.logger ?? rootLogger).child({ module: 'search' });
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? SEARCH_MAX_CONCURRENT);
  const limit = options.limit ?? LIMITS.searchHitsMax;
  const byClient = new Map<ClientId, Job>();
  const waiting: Job[] = [];
  let running = 0;

  const jobEntries = (entries: readonly Entry[]): SearchJobEntry[] =>
    [...entries]
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
      .map((entry) => ({
        entryId: entry.id,
        title: entry.title,
        lastActivityAt: entry.lastActivityAt,
        summary:
          entry.turnSummary === null ? null : { text: entry.turnSummary.text, at: entry.turnSummary.at },
        conversations: entry.conversations.map((c) => ({
          conversationId: c.id,
          file: transcriptPath(options.home, entry.id, c.id),
        })),
        plansDir: path.dirname(planPath(options.home, entry.id, 1)),
      }));

  /** Ends a job once; frees its slot and starts the next waiting one. */
  const settle = (job: Job, outcome: { result: SearchResult } | { error: CommandError }): void => {
    if (job.done) return;
    job.done = true;
    if (job.timer !== null) clearTimeout(job.timer);
    job.timer = null;
    if (byClient.get(job.clientId) === job) byClient.delete(job.clientId);
    const index = waiting.indexOf(job);
    if (index >= 0) waiting.splice(index, 1);
    const worker = job.worker;
    job.worker = null;
    if (worker !== null) {
      running -= 1;
      void worker.terminate().catch(() => undefined);
    }
    if ('result' in outcome) job.resolve(outcome.result);
    else job.reject(outcome.error);
    startNext();
  };

  const onReply = (job: Job, raw: unknown): void => {
    const reply = workerReplySchema.safeParse(raw);
    if (!reply.success) {
      log.warn('search worker sent an invalid answer');
      settle(job, { error: searchFailed('worker') });
      return;
    }
    if (!reply.data.ok) {
      log.warn({ message: reply.data.message.slice(0, 300) }, 'search worker failed');
      settle(job, { error: searchFailed('failed') });
      return;
    }
    const hits: SearchHit[] = [];
    let invalid = 0;
    for (const candidate of reply.data.hits) {
      const hit = searchHitSchema.safeParse(candidate);
      if (hit.success) hits.push(hit.data);
      else invalid += 1;
    }
    if (invalid > 0 || reply.data.skippedLines > 0) {
      log.warn(
        { invalid, skippedLines: reply.data.skippedLines },
        'search: dropped hits or skipped long lines',
      );
    }
    settle(job, { result: { hits: hits.slice(0, limit), truncated: reply.data.truncated } });
  };

  const start = (job: Job): void => {
    running += 1;
    const worker = new Worker(SEARCH_WORKER_SOURCE, {
      eval: true,
      workerData: job.data,
      // No inherited loader/inspector flags of the parent (tsx, Vitest).
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: SEARCH_WORKER_HEAP_MB },
    });
    // A running search never keeps the server alive at shutdown.
    worker.unref();
    job.worker = worker;
    job.timer = setTimeout(() => {
      log.warn({ timeoutMs }, 'search timed out');
      settle(job, { error: searchFailed('timeout') });
    }, timeoutMs);
    job.timer.unref();
    worker.on('message', (raw: unknown) => {
      onReply(job, raw);
    });
    worker.on('error', (error: unknown) => {
      log.warn({ err: toError(error) }, 'search worker crashed');
      settle(job, { error: searchFailed('worker') });
    });
    worker.on('exit', (code) => {
      if (!job.done) {
        log.warn({ code }, 'search worker ended without an answer');
        settle(job, { error: searchFailed('worker') });
      }
    });
  };

  function startNext(): void {
    while (running < maxConcurrent) {
      const next = waiting.shift();
      if (next === undefined) return;
      start(next);
    }
  }

  return {
    query(clientId, query, entries) {
      const older = byClient.get(clientId);
      if (older !== undefined) settle(older, { error: searchFailed('superseded') });
      return new Promise<SearchResult>((resolve, reject) => {
        const job: Job = {
          clientId,
          data: {
            text: query.text,
            includeToolOutput: query.includeToolOutput,
            limit,
            snippetChars: LIMITS.searchSnippetChars,
            snippetLead: SEARCH_SNIPPET_LEAD,
            rangesMax: LIMITS.searchRangesMax,
            maxLineBytes: options.maxLineBytes ?? SEARCH_MAX_LINE_BYTES,
            entries: jobEntries(entries),
          },
          resolve,
          reject,
          worker: null,
          timer: null,
          done: false,
        };
        byClient.set(clientId, job);
        waiting.push(job);
        startNext();
      });
    },

    close() {
      for (const job of [...byClient.values()]) settle(job, { error: searchFailed('failed') });
    },
  };
}
