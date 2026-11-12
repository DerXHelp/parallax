import { useEffect, useRef, useSyncExternalStore } from 'react';
import { LIMITS, parseSessionKey } from '@shared/common';
import { makeError } from '@shared/errors';
import type { FileStatResult } from '@shared/model';
import { windowsPathIssue, windowsPathKey } from '@shared/paths';
import { SizedLru } from '@web/lib/sized-cache';
import { ClientCommandError } from '@web/state/connection';
import { sendCommand } from '@web/state/hooks';
import { useFileWriteStamp } from './file-tools';

/**
 * Existence check of file references (WP-54, C.10, ADR-141): `FileLink` with `verify` shows a link
 * only after `file.statMany` answered `ok: true`. Requests are collected for 50 ms and sent in
 * batches of at most `LIMITS.fileStatBatchMax` per session; answers stay 30 s (LRU, 2 000 entries)
 * and are dropped early when a write tool finishes on the same file. Only paths that pass
 * `windowsPathIssue` are ever sent (defence in depth – FileLink filters before).
 */

export const STAT_BATCH_MS = 50;
export const STAT_TTL_MS = 30_000;
export const STAT_CACHE_MAX = 2000;
/** A failed command is retried no earlier than after this time (next `ensure`). */
export const STAT_RETRY_MS = 5000;

export interface StatEntry {
  /** null until the first answer (and after a failed command without an earlier answer). */
  result: FileStatResult | null;
  /** Time of the answer (ms); expired entries are fetched again by the next `ensure`. */
  at: number;
  loading: boolean;
}

/** Sends one `file.statMany` batch; answers in the order of `paths`. */
export type StatSender = (sessionKey: string, paths: readonly string[]) => Promise<readonly FileStatResult[]>;

export interface StatCacheOptions {
  send: StatSender;
  now?: () => number;
  batchMs?: number;
  ttlMs?: number;
  maxEntries?: number;
}

function cacheKey(sessionKey: string, path: string): string {
  return `${sessionKey}\u0000${windowsPathKey(path)}`;
}

export class StatCache {
  private readonly send: StatSender;
  private readonly now: () => number;
  private readonly batchMs: number;
  private readonly ttlMs: number;
  private readonly entries: SizedLru<string, StatEntry>;
  private readonly listeners = new Set<() => void>();
  /** Waiting paths per session: key → path as first requested. */
  private readonly pending = new Map<string, Map<string, string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A notification is queued (microtask): changes of one render/answer reach the listeners once. */
  private notifyQueued = false;

  constructor(options: StatCacheOptions) {
    this.send = options.send;
    this.now = options.now ?? Date.now;
    this.batchMs = options.batchMs ?? STAT_BATCH_MS;
    this.ttlMs = options.ttlMs ?? STAT_TTL_MS;
    this.entries = new SizedLru({
      maxEntries: options.maxEntries ?? STAT_CACHE_MAX,
      maxSize: Number.POSITIVE_INFINITY,
    });
  }

  /** Number of cached entries (tests). */
  get size(): number {
    return this.entries.count;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The entry of a path (no LRU touch – safe in render). */
  peek(sessionKey: string, path: string): StatEntry | undefined {
    return this.entries.peek(cacheKey(sessionKey, path));
  }

  /** Fetches the path unless a fresh answer exists or a request is under way. */
  ensure(sessionKey: string, path: string): void {
    if (windowsPathIssue(path) !== null || parseSessionKey(sessionKey) === null) return;
    const key = cacheKey(sessionKey, path);
    const entry = this.entries.get(key);
    if (entry !== undefined && (entry.loading || this.now() - entry.at < this.ttlMs)) return;
    this.write(key, { result: entry?.result ?? null, at: entry?.at ?? 0, loading: true });
    let batch = this.pending.get(sessionKey);
    if (batch === undefined) {
      batch = new Map();
      this.pending.set(sessionKey, batch);
    }
    if (!batch.has(key)) batch.set(key, path);
    this.timer ??= setTimeout(() => {
      this.flush();
    }, this.batchMs);
    this.queueNotify();
  }

  /** Drops the freshness of an answer (it stays visible until the new one arrives). */
  invalidate(sessionKey: string, path: string): void {
    const key = cacheKey(sessionKey, path);
    const entry = this.entries.peek(key);
    if (entry === undefined || entry.loading || entry.at === 0) return;
    this.write(key, { ...entry, at: 0 });
    this.queueNotify();
  }

  /** Invalidates the answer when it is older than `at` (a write finished after it was fetched). */
  invalidateBefore(sessionKey: string, path: string, at: number): void {
    const entry = this.entries.peek(cacheKey(sessionKey, path));
    if (entry !== undefined && !entry.loading && entry.at < at) this.invalidate(sessionKey, path);
  }

  /** Sends the waiting requests now (tests; normally the 50 ms timer does it). */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const batches = [...this.pending.entries()];
    this.pending.clear();
    for (const [sessionKey, batch] of batches) {
      const items = [...batch.entries()];
      for (let start = 0; start < items.length; start += LIMITS.fileStatBatchMax) {
        void this.sendChunk(sessionKey, items.slice(start, start + LIMITS.fileStatBatchMax));
      }
    }
  }

  /** Forgets everything (tests). */
  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.entries.clear();
    this.notify();
  }

  private async sendChunk(sessionKey: string, items: readonly (readonly [string, string])[]): Promise<void> {
    const paths = items.map(([, path]) => path);
    try {
      const results = await this.send(sessionKey, paths);
      const at = this.now();
      items.forEach(([key], index) => {
        const result = results[index];
        if (result === undefined) this.fail(key);
        else this.write(key, { result, at, loading: false });
      });
    } catch {
      for (const [key] of items) this.fail(key);
    }
    this.queueNotify();
  }

  /** No answer: keep an earlier one, retry after STAT_RETRY_MS. */
  private fail(key: string): void {
    const previous = this.entries.peek(key);
    this.write(key, {
      result: previous?.result ?? null,
      at: this.now() - this.ttlMs + STAT_RETRY_MS,
      loading: false,
    });
  }

  private write(key: string, entry: StatEntry): void {
    this.entries.set(key, entry, 1, (value) => value.loading);
  }

  /**
   * Notifies once per microtask (R5W-10): n links mounting in one render each call `ensure` from
   * their effect – notifying every time would run all n selectors n times (O(n²)). The snapshot
   * (`peek`) is always current, so a late notification only delays the re-render check.
   */
  private queueNotify(): void {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      this.notify();
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The real sender: `file.statMany` to the host of the session. */
async function sendStatMany(
  sessionKey: string,
  paths: readonly string[],
): Promise<readonly FileStatResult[]> {
  const entryId = parseSessionKey(sessionKey)?.entryId;
  if (entryId === undefined)
    throw new ClientCommandError(makeError('VALIDATION_FAILED', { path: 'sessionKey' }));
  const { results } = await sendCommand(sessionKey, { name: 'file.statMany', entryId, paths: [...paths] });
  return results;
}

/** One cache per window (shared by every FileLink). */
export const statCache = new StatCache({ send: sendStatMany });

/**
 * The stat answer of `path` (`null` = do not check), fetched through the batching cache; re-checks
 * after a finished write tool on the same file. Undefined until the first answer.
 */
export function useFileStat(
  sessionKey: string,
  path: string | null,
  cache: StatCache = statCache,
): StatEntry | undefined {
  const entry = useSyncExternalStore(cache.subscribe, () =>
    path === null ? undefined : cache.peek(sessionKey, path),
  );
  const written = useFileWriteStamp(path === null ? null : sessionKey, path);
  // Each write stamp invalidates at most once per link (a host clock ahead of ours must not loop).
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (path === null) return;
    if (written !== null && written !== handled.current) {
      handled.current = written;
      cache.invalidateBefore(sessionKey, path, written);
    }
    cache.ensure(sessionKey, path);
  }, [cache, sessionKey, path, entry, written]);
  return entry;
}
